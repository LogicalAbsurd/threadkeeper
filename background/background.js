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
//   - No global mutable state that must survive suspension — use browser.storage.
//   - The event page stays alive while an async chain is running (e.g., during
//     a bulk export loop), but we snapshot state to storage after each
//     conversation for crash recovery.

'use strict';

console.log('Threadkeeper background loaded');


// --- Export state ---
// In-memory for speed during active export. Synced to browser.storage.local
// after each conversation for crash recovery. The accumulated[] array is only
// populated when outputMode is 'combined' or 'both' — for 'individual' mode,
// per-chat data is discarded after download to avoid ~50-100MB memory at 150+ chats.

let exportState = {
  phase: 'idle',       // 'idle'|'running'|'paused'|'complete'|'cancelled'
  tabId: null,
  site: null,          // 'gemini'|'chatgpt'|'claude' — determines export strategy
  format: 'markdown',  // 'markdown'|'json'|'both'
  outputMode: 'both',  // 'individual'|'combined'|'both'
  conversations: [],   // [{id, title, url}] — sidebar-extracted, source of truth for titles
  currentIndex: 0,
  currentTitle: '',
  completed: [],       // [{id, title}]
  failed: [],          // [{id, title, error}]
  startTime: null,
  accumulated: [],     // conversation data objects for combined output
  includeThinking: true, // Claude-specific: include extended thinking blocks
};


// --- Message routing ---
// Registered synchronously at top level so it survives event-page restarts.

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'EXPORT_CURRENT':
      handleExportCurrent(message.format)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'LIST_CONVERSATIONS':
      handleListConversations(message.tabId, message.includeArchived)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'START_BULK_EXPORT':
      handleStartBulkExport(message)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'PAUSE_EXPORT':
      if (exportState.phase === 'running') exportState.phase = 'paused';
      broadcastProgress();
      sendResponse({ ok: true });
      return;

    case 'RESUME_EXPORT':
      if (exportState.phase === 'paused') {
        exportState.phase = 'running';
        broadcastProgress();
      }
      sendResponse({ ok: true });
      return;

    case 'CANCEL_EXPORT':
      if (exportState.phase === 'running' || exportState.phase === 'paused') {
        exportState.phase = 'cancelled';
        broadcastProgress();
      }
      sendResponse({ ok: true });
      return;

    case 'GET_EXPORT_STATE':
      sendResponse(getExportStateSummary());
      return;

    case 'RETRY_FAILED':
      handleRetryFailed()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'CONTENT_READY':
      // Handled by the one-shot listener in waitForContentReady().
      // Main dispatch ignores it.
      return;
  }
});


// --- Single-chat export (Phase 3, refactored) ---

async function handleExportCurrent(format) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'No active tab found.' };

  let response;
  try {
    response = await browser.tabs.sendMessage(tab.id, { type: 'PARSE_CURRENT' });
  } catch (_err) {
    return { ok: false, error: 'Content script not ready. Try refreshing the page.' };
  }

  if (!response?.ok) return { ok: false, error: response?.error ?? 'Unknown scrape error.' };

  await downloadConversation(response.data, format);
  return { ok: true };
}


// --- List conversations ---

async function handleListConversations(tabId, includeArchived = false) {
  const resolvedTabId = tabId || await findSupportedTabId();
  if (!resolvedTabId) {
    return { ok: false, error: 'No supported AI tab found. Open Gemini, ChatGPT, or Claude and try again.' };
  }

  try {
    return await browser.tabs.sendMessage(resolvedTabId, { type: 'LIST_CONVERSATIONS', includeArchived });
  } catch (_err) {
    return { ok: false, error: 'Content script not ready. Try refreshing the page.' };
  }
}

async function findSupportedTabId() {
  for (const pattern of ['https://gemini.google.com/*', 'https://chatgpt.com/*', 'https://claude.ai/*']) {
    const tabs = await browser.tabs.query({ url: pattern });
    if (tabs[0]?.id) return tabs[0].id;
  }
  return null;
}


// --- Bulk export ---

async function handleStartBulkExport({ tabId, conversations, format, outputMode, site, includeThinking }) {
  if (exportState.phase === 'running' || exportState.phase === 'paused') {
    return { ok: false, error: 'Export already in progress.' };
  }

  if (!conversations || conversations.length === 0) {
    return { ok: false, error: 'No conversations selected.' };
  }

  if (conversations.length > 200) {
    console.warn(`[Threadkeeper] Large export: ${conversations.length} conversations.`);
  }

  exportState = {
    phase: 'running',
    tabId,
    site: site || 'gemini',
    format: format || 'markdown',
    outputMode: outputMode || 'both',
    includeThinking: includeThinking !== false,
    conversations,
    currentIndex: 0,
    currentTitle: '',
    completed: [],
    failed: [],
    startTime: new Date().toISOString(),
    accumulated: [],
  };

  await saveStateToStorage();
  broadcastProgress();

  // Fire-and-forget — respond immediately so the export page can show progress.
  runExport().catch((err) => {
    console.error('[Threadkeeper] Export loop crashed:', err);
    exportState.phase = 'cancelled';
    broadcastProgress();
  });

  return { ok: true };
}

async function runExport() {
  const delayMs = await getBulkDelay();
  const needsAccumulation = exportState.outputMode !== 'individual';
  // ChatGPT and Claude use API-only fetch (no tab navigation needed).
  // Gemini uses navigate-tab + DOM scraping via PARSE_CURRENT.
  const useApiFetch = exportState.site === 'chatgpt' || exportState.site === 'claude';

  for (let i = exportState.currentIndex; i < exportState.conversations.length; i++) {
    // Check for pause — spin-wait with 200ms granularity.
    while (exportState.phase === 'paused') {
      await sleep(200);
    }
    if (exportState.phase === 'cancelled') break;

    exportState.currentIndex = i;
    const conv = exportState.conversations[i];
    const chatId = conv.id;
    const knownTitle = conv.title;
    exportState.currentTitle = knownTitle;
    broadcastProgress();

    try {
      let data;

      if (useApiFetch) {
        // ChatGPT: fetch conversation via API without navigating the tab.
        console.log(`[TK-DIAG] runExport — API fetch for "${chatId}"`);
        const response = await browser.tabs.sendMessage(exportState.tabId, {
          type: 'FETCH_CONVERSATION',
          chatId,
          includeThinking: exportState.includeThinking,
        });
        console.log(`[TK-DIAG] runExport — FETCH_CONVERSATION response for "${chatId}": ` +
          `ok=${response?.ok}, messages=${response?.data?.messages?.length ?? 'N/A'}, ` +
          `title="${response?.data?.title ?? 'N/A'}"`);
        if (!response?.ok) throw new Error(response?.error || 'Fetch failed');
        data = response.data;
      } else {
        // Gemini (and future DOM-scraping sites): navigate tab + PARSE_CURRENT.
        await browser.tabs.update(exportState.tabId, {
          url: `https://gemini.google.com/app/${chatId}`,
        });
        await waitForContentReady(exportState.tabId, chatId, 15000);
        console.log(`[TK-DIAG] runExport — content ready for "${chatId}", sending PARSE_CURRENT`);

        const response = await browser.tabs.sendMessage(exportState.tabId, {
          type: 'PARSE_CURRENT',
        });
        console.log(`[TK-DIAG] runExport — PARSE_CURRENT response for "${chatId}": ` +
          `ok=${response?.ok}, messages=${response?.data?.messages?.length ?? 'N/A'}, ` +
          `parsedTitle="${response?.data?.title ?? 'N/A'}", knownTitle="${knownTitle}"`);
        if (!response?.ok) throw new Error(response?.error || 'Parse failed');
        data = response.data;
      }

      // Override title with the known title from the conversation list.
      // For Gemini, the sidebar title is more reliable than the parsed title.
      // For ChatGPT, the API title matches the list, but we use the list
      // title for consistency across the pipeline.
      if (knownTitle) data.title = knownTitle;
      exportState.currentTitle = data.title;

      // Download individual file(s) if needed.
      if (exportState.outputMode !== 'combined') {
        await downloadConversation(data, exportState.format);
      }

      // Accumulate for combined output only when needed.
      if (needsAccumulation) {
        exportState.accumulated.push(data);
      }

      exportState.completed.push({ id: chatId, title: data.title });

    } catch (err) {
      console.error(`[Threadkeeper] Failed to export ${chatId}:`, err);
      exportState.failed.push({
        id: chatId,
        title: knownTitle || chatId,
        error: err.message,
      });
    }

    await saveStateToStorage();
    broadcastProgress();

    // Rate-limit between conversations.
    if (i < exportState.conversations.length - 1) {
      await sleep(delayMs);
    }
  }

  // Write combined file(s) at the end.
  if (exportState.phase !== 'cancelled' && needsAccumulation && exportState.accumulated.length > 0) {
    await writeCombinedOutput();
  }

  if (exportState.phase !== 'cancelled') {
    exportState.phase = 'complete';
  }

  await saveStateToStorage();
  broadcastProgress();
}

async function handleRetryFailed() {
  if (exportState.failed.length === 0) {
    return { ok: false, error: 'No failed conversations to retry.' };
  }

  // Rebuild conversation objects from the failed array (which has id + title).
  const site = exportState.site || 'gemini';
  exportState.conversations = exportState.failed.map((f) => ({
    id: f.id,
    title: f.title,
    url: f.url || buildConversationUrl(site, f.id),
  }));
  exportState.currentIndex = 0;
  exportState.failed = [];
  exportState.accumulated = [];
  exportState.phase = 'running';
  exportState.startTime = new Date().toISOString();

  await saveStateToStorage();
  broadcastProgress();

  runExport().catch((err) => {
    console.error('[Threadkeeper] Retry loop crashed:', err);
    exportState.phase = 'cancelled';
    broadcastProgress();
  });

  return { ok: true };
}


// --- Content script ready handshake ---
// When background navigates a tab to a new conversation, the page reloads and
// a new content script injects. That script sends CONTENT_READY with its chatId
// (from URL). We register a one-shot listener that only resolves when the
// chatId matches the expected navigation target — stale signals from previous
// navigations are ignored.

function waitForContentReady(tabId, expectedChatId, timeout) {
  // [DIAG] Log what we're waiting for.
  console.log(`[TK-DIAG] waitForContentReady — expecting chatId="${expectedChatId}" on tab ${tabId}`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.runtime.onMessage.removeListener(onReady);
      // [DIAG] Log timeout.
      console.log(`[TK-DIAG] waitForContentReady TIMEOUT — never got chatId="${expectedChatId}"`);
      reject(new Error(`Content script did not load in time for chat ${expectedChatId}`));
    }, timeout);

    function onReady(message, sender) {
      if (message.type !== 'CONTENT_READY') return;
      // [DIAG] Log every CONTENT_READY we see, even mismatches.
      console.log(`[TK-DIAG] waitForContentReady received CONTENT_READY — ` +
        `chatId="${message.chatId}", senderTab=${sender.tab?.id}, ` +
        `expectedTab=${tabId}, expectedChatId="${expectedChatId}", ` +
        `match=${sender.tab?.id === tabId && message.chatId === expectedChatId}`);
      if (sender.tab?.id !== tabId) return;
      if (message.chatId !== expectedChatId) return;
      clearTimeout(timer);
      browser.runtime.onMessage.removeListener(onReady);
      resolve();
    }

    browser.runtime.onMessage.addListener(onReady);
  });
}


// --- Download helpers ---

async function downloadFile(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const downloadId = await browser.downloads.download({
    url,
    filename,
    saveAs: false,
  });

  function onChanged(delta) {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') {
      URL.revokeObjectURL(url);
      browser.downloads.onChanged.removeListener(onChanged);
    }
  }
  browser.downloads.onChanged.addListener(onChanged);
}

async function downloadConversation(data, format) {
  const date = new Date(data.exportedAt);
  if (format === 'markdown' || format === 'both') {
    await downloadFile(toMarkdown(data), 'text/markdown', safeFilename(data.title, date, 'md'));
  }
  if (format === 'json' || format === 'both') {
    await downloadFile(toJSON(data), 'application/json', safeFilename(data.title, date, 'json'));
  }
}

async function writeCombinedOutput() {
  const { accumulated, format } = exportState;
  const now = new Date();
  const slug = `threadkeeper-bulk-export-${accumulated.length}-conversations`;

  if (format === 'markdown' || format === 'both') {
    await downloadFile(toCombinedMarkdown(accumulated), 'text/markdown', safeFilename(slug, now, 'md'));
  }
  if (format === 'json' || format === 'both') {
    await downloadFile(toCombinedJSON(accumulated), 'application/json', safeFilename(slug, now, 'json'));
  }
}


// --- State helpers ---

function buildConversationUrl(site, chatId) {
  if (site === 'chatgpt') return `https://chatgpt.com/c/${chatId}`;
  if (site === 'claude') return `https://claude.ai/chat/${chatId}`;
  return `https://gemini.google.com/app/${chatId}`;
}

function getExportStateSummary() {
  const { phase, format, outputMode, conversations, currentIndex, currentTitle,
          completed, failed, startTime } = exportState;
  return {
    phase,
    format,
    outputMode,
    total: conversations.length,
    currentIndex,
    currentTitle,
    completedCount: completed.length,
    failedCount: failed.length,
    failed,
    startTime,
  };
}

async function getBulkDelay() {
  const stored = await browser.storage.local.get('bulkDelay');
  const delay = parseInt(stored.bulkDelay, 10);
  return Number.isFinite(delay) && delay >= 0 ? delay : 500;
}

async function saveStateToStorage() {
  // Persist everything except accumulated (too large for storage).
  const { phase, site, format, outputMode, includeThinking, conversations,
          currentIndex, completed, failed, startTime } = exportState;
  await browser.storage.local.set({
    exportState: { phase, site, format, outputMode, includeThinking, conversations,
                   currentIndex, completed, failed, startTime },
  });
}

function broadcastProgress() {
  browser.runtime.sendMessage({
    type: 'EXPORT_PROGRESS',
    state: getExportStateSummary(),
  }).catch(() => {
    // No listener connected (export page not open) — ignore.
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
