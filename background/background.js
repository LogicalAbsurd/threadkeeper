// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

// Background script — Firefox-first (v1).
//
// Uses the manifest's background.scripts array, NOT service_worker.
// Firefox 121+ processes both keys if present, causing dual initialization
// that breaks the popup (toolbar button enters a corrupt state on first click).
// Keeping only scripts avoids this entirely.
//
// Chrome MV3 requires service_worker instead of scripts. Phase 7 will add
// a build step to generate a Chrome-specific manifest that swaps
// scripts → service_worker and adds importScripts() for the lib files.
//
// Lib files (filename.js, markdown.js, json.js) are listed before this file
// in the manifest scripts array, so their globals are already available here.
//
// Rules for this file (event-page lifecycle):
//   - Register all listeners synchronously at the top level.
//   - No global mutable state — use browser.storage for persistence.
//   - The event page can be suspended at any time when idle.

'use strict';

console.log('Threadkeeper background loaded');

// --- Message routing ---
// Registered synchronously at top level so it survives service worker restarts.

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'EXPORT_CURRENT') return;

  handleExportCurrent(message.format)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  // Return true to keep the message channel open for the async sendResponse.
  return true;
});

async function handleExportCurrent(format) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: 'No active tab found.' };
  }

  let response;
  try {
    response = await browser.tabs.sendMessage(tab.id, { type: 'PARSE_CURRENT' });
  } catch (_err) {
    // sendMessage throws if no content script is listening — e.g., the user
    // is on a supported domain but the page hasn't finished loading, or the
    // content script errored on injection.
    return { ok: false, error: 'Content script not ready. Try refreshing the page.' };
  }

  if (!response?.ok) {
    return { ok: false, error: response?.error ?? 'Unknown scrape error.' };
  }

  const { data } = response;
  const date = new Date(data.exportedAt);

  let content, ext;
  if (format === 'json') {
    content = toJSON(data);
    ext = 'json';
  } else {
    content = toMarkdown(data);
    ext = 'md';
  }

  const filename = safeFilename(data.title, date, ext);

  // Blob + object URL instead of data URLs because Firefox MV3 blocks
  // data: URLs in browser.downloads.download(). createObjectURL works
  // in both Firefox event pages and Chrome MV3 service workers.
  const mimeType = format === 'json' ? 'application/json' : 'text/markdown';
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const downloadId = await browser.downloads.download({
    url,
    filename,
    saveAs: false,
  });

  // Revoke the object URL once the download finishes (or fails/is canceled)
  // to free memory. Uses a one-shot listener scoped to this download ID.
  function onChanged(delta) {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      URL.revokeObjectURL(url);
      browser.downloads.onChanged.removeListener(onChanged);
    }
  }
  browser.downloads.onChanged.addListener(onChanged);

  return { ok: true };
}
