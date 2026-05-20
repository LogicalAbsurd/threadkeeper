// Cross-browser background script.
//
// Chrome MV3: runs as a service worker (background.service_worker).
//   - No DOM access, no global state that survives idle timeout (~30s).
//   - All persistent state must go through chrome.storage.
//   - Event listeners must be registered synchronously at the top level
//     on every startup — they cannot be added inside async callbacks.
//
// Firefox MV3: runs as an event page (background.scripts).
//   - Similar idle-suspend lifecycle, but the page has a DOM (document,
//     window) and can use XMLHttpRequest in addition to fetch.
//   - Same rule: register listeners at top level, persist state in storage.
//
// Practical upshot: write this file as if it's a service worker (the
// stricter model). Avoid global mutable state, register all listeners
// synchronously, and use browser.storage for anything that must survive
// a restart. That way it works in both browsers.
//
// Lib loading strategy:
//   Chrome: service_worker only loads this one file, so we importScripts()
//           the lib files. importScripts() is available in service workers.
//   Firefox: the manifest's background.scripts array lists the lib files
//            before this file, so they're already loaded. importScripts()
//            is NOT available in Firefox event pages.
//   We feature-detect to handle both: call importScripts() only when
//   available (Chrome), skip it when libs are pre-loaded (Firefox).

'use strict';

if (typeof importScripts === 'function') {
  importScripts('lib/filename.js', 'lib/markdown.js', 'lib/json.js');
}

console.log('Chat Archiver background loaded');

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
