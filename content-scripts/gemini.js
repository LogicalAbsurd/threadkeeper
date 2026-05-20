// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

// Gemini scraper — content script for gemini.google.com.
// Loaded after shared.js, so htmlToMarkdown() and sleep() are available.

// --- Title detection ---

function getTitle() {
  // HIGH stability: data-test-id is part of Google's internal test infra.
  const testId = document.querySelector('[data-test-id="conversation-title"]');
  if (testId?.textContent.trim()) return testId.textContent.trim();

  // MEDIUM stability: class-based, but semantically named.
  const classTitle = document.querySelector('.conversation-title');
  if (classTitle?.textContent.trim()) return classTitle.textContent.trim();

  // Fallback: strip the "Gemini - " prefix from the page title.
  const pageTitle = document.title.replace(/^Gemini\s*[-–—]\s*/i, '').trim();
  if (pageTitle && pageTitle !== 'Gemini') return pageTitle;

  // Last resort: first user message, truncated.
  const firstQuery = document.querySelector('user-query');
  if (firstQuery) {
    const text = firstQuery.innerText.trim();
    if (text) return text.length > 60 ? text.slice(0, 57) + '...' : text;
  }

  return 'Untitled conversation';
}


// --- Scroll to top + stability detector for lazy-loaded messages ---

async function ensureAllMessagesLoaded() {
  // Scroll container selector cascade, ordered by stability.
  // HIGH: data-test-id. MEDIUM: custom elements. LOW: class names.
  const container =
    document.querySelector('[data-test-id="chat-history-container"]') ||
    document.querySelector('infinite-scroller') ||
    document.querySelector('.chat-scrollable-container') ||
    document.scrollingElement;

  if (!container) return;

  container.scrollTop = 0;

  // Poll message count every 200ms. Load is complete when count is unchanged
  // across 3 consecutive polls (stable for 600ms). Cap total wait at 10s.
  const POLL_INTERVAL = 200;
  const STABLE_THRESHOLD = 3;
  const MAX_WAIT = 10000;

  let stableCount = 0;
  let lastMessageCount = -1;
  let elapsed = 0;

  while (stableCount < STABLE_THRESHOLD && elapsed < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    elapsed += POLL_INTERVAL;

    const current = document.querySelectorAll('user-query, model-response').length;
    if (current === lastMessageCount) {
      stableCount++;
    } else {
      stableCount = 0;
      lastMessageCount = current;
    }
  }

  if (elapsed >= MAX_WAIT) {
    console.warn(
      '[Threadkeeper] Scroll stability timeout — some older messages may not have loaded. ' +
      `Found ${lastMessageCount} message turns in ${MAX_WAIT}ms.`
    );
  }
}


// --- Parse messages ---

async function parseMessages() {
  await ensureAllMessagesLoaded();

  // user-query and model-response are Angular custom elements — HIGH stability.
  // They're part of Gemini's component registration, not styling classes.
  const turns = document.querySelectorAll('user-query, model-response');
  const messages = [];

  for (const turn of turns) {
    const tag = turn.tagName.toLowerCase();

    if (tag === 'user-query') {
      // LOW stability: .query-text and .query-text-line are styling classes.
      // Fallback to .innerText of the whole element if classes change.
      const textEl =
        turn.querySelector('.query-text .query-text-line') ||
        turn.querySelector('.query-text') ||
        turn;
      const content = textEl.innerText.trim();
      if (content) messages.push({ role: 'user', content });

    } else if (tag === 'model-response') {
      // MEDIUM stability: message-content is a custom element; .markdown is a class.
      const contentEl =
        turn.querySelector('message-content .markdown') ||
        turn.querySelector('message-content') ||
        turn;

      let content = '';

      // model-thoughts is a custom element for reasoning/thinking blocks.
      const thoughtsEl = turn.querySelector('model-thoughts');
      if (thoughtsEl) {
        // LOW stability: .thoughts-body is a styling class inside the thoughts component.
        const thoughtsBody = thoughtsEl.querySelector('.thoughts-body') || thoughtsEl;
        const thoughtsText = htmlToMarkdown(thoughtsBody);
        if (thoughtsText) {
          content += '> **Thinking**\n' +
            thoughtsText.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n';
        }
      }

      content += htmlToMarkdown(contentEl);
      if (content.trim()) messages.push({ role: 'assistant', content: content.trim() });
    }
  }

  return messages;
}


// --- Stubs for Phase 4 (bulk/selective export) ---

// eslint-disable-next-line no-unused-vars
function listConversations() {
  return Promise.resolve([]);
}

// eslint-disable-next-line no-unused-vars
function loadConversation(_id) {
  return Promise.reject(new Error('Not implemented — Phase 4'));
}


// --- Message listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type !== 'PARSE_CURRENT') return;

  // Return a Promise for async response. Supported in both Chrome MV3
  // and Firefox Gecko 115+ (our floor version).
  return (async () => {
    try {
      const messages = await parseMessages();
      const title = getTitle();

      return {
        ok: true,
        data: {
          site: 'gemini',
          title,
          url: window.location.href,
          exportedAt: new Date().toISOString(),
          messages,
        },
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();
});
