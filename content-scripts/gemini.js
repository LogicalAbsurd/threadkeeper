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


// --- List all conversations from the sidebar ---

async function listConversations() {
  // Ensure sidebar is visible — Gemini hides it behind a hamburger on small viewports.
  // MEDIUM stability: aria-label is more stable than class names.
  const hamburger = document.querySelector(
    'button[aria-label="Main menu"], button[aria-label="Open sidebar"]'
  );
  if (hamburger) {
    const nav = document.querySelector('nav, [data-test-id="sidebar"]');
    if (!nav || getComputedStyle(nav).display === 'none') {
      hamburger.click();
      await sleep(400);
    }
  }

  // Find the sidebar scroll container.
  // HIGH stability: <conversations-list data-test-id="all-conversations"> is an
  // Angular component wrapping all sidebar entries.
  // Fallbacks: nav-based selectors for older layouts.
  const sidebarScroller =
    document.querySelector('[data-test-id="all-conversations"]') ||
    document.querySelector('[data-test-id="sidebar-scroller"]') ||
    document.querySelector('nav infinite-scroller') ||
    document.querySelector('infinite-scroller');

  if (!sidebarScroller) return [];

  // Scroll sidebar to bottom to lazy-load all conversation entries.
  // Same stability-polling pattern as ensureAllMessagesLoaded().
  const POLL_INTERVAL = 200;
  const STABLE_THRESHOLD = 3;
  const MAX_WAIT = 15000;

  let stableCount = 0;
  let lastCount = -1;
  let elapsed = 0;

  while (stableCount < STABLE_THRESHOLD && elapsed < MAX_WAIT) {
    sidebarScroller.scrollTop = sidebarScroller.scrollHeight;
    await sleep(POLL_INTERVAL);
    elapsed += POLL_INTERVAL;

    // HIGH stability: data-test-id="conversation" is a Google test infra attribute.
    // The element is <gem-nav-list-item> (Angular component name, HIGH stability),
    // NOT an <a> tag — the <a> is a child used only for URL extraction.
    const current = sidebarScroller.querySelectorAll('[data-test-id="conversation"]').length;
    if (current === lastCount) {
      stableCount++;
    } else {
      stableCount = 0;
      lastCount = current;
    }
  }

  if (elapsed >= MAX_WAIT) {
    console.warn(
      `[Threadkeeper] Sidebar scroll timeout — may have missed older conversations. ` +
      `Found ${lastCount} so far.`
    );
  }

  // HIGH stability: data-test-id="conversation" on <gem-nav-list-item> elements.
  const items = sidebarScroller.querySelectorAll('[data-test-id="conversation"]');
  const conversations = [];

  for (const item of items) {
    // URL lives on a child <a>, not on the custom element itself.
    const anchor = item.querySelector('a');
    const href = anchor?.getAttribute('href') || '';
    const id = href.split('/').pop();
    if (!id) continue;

    // Title is the visible text of the list item. No dedicated .conversation-title
    // class exists in current DOM — innerText of the element is the title.
    // Cap at 200 chars to avoid accidentally grabbing extra text from child nodes.
    let title = (item.innerText || '').trim();
    if (title.length > 200) title = title.slice(0, 197) + '...';
    if (!title) title = `Conversation ${id}`;

    const fullUrl = anchor?.href || `https://gemini.google.com/app/${id}`;

    conversations.push({ id, title, url: fullUrl });
  }

  return conversations;
}

// Stub — background owns all navigation via browser.tabs.update().
// Content script does not navigate directly. Kept as a documented no-op
// to satisfy the site abstraction interface; may be removed in a later phase.
// eslint-disable-next-line no-unused-vars
function loadConversation(_id) {
  return Promise.resolve();
}


// --- Message listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'PARSE_CURRENT') {
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
  }

  if (message.type === 'LIST_CONVERSATIONS') {
    return (async () => {
      try {
        const data = await listConversations();
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }
});


// --- DevTools smoke-check ---
// Paste this in the browser console on gemini.google.com to verify selectors
// before reloading the extension:
//
//   const container = document.querySelector('[data-test-id="all-conversations"]');
//   const items = container?.querySelectorAll('[data-test-id="conversation"]') || [];
//   console.log(`Found ${items.length} conversations in sidebar`);
//   for (const el of [...items].slice(0, 5)) {
//     const a = el.querySelector('a');
//     const title = (el.innerText || '').trim().slice(0, 80);
//     console.log(`  [${el.tagName.toLowerCase()}] "${title}" → ${a?.href || '(no link)'}`);
//   }


// --- CONTENT_READY signal ---
// Sent at top level on every page load so the background knows this content
// script instance is alive and ready. Includes chatId (from URL) so background
// can match it to the navigation target it's waiting on during bulk export —
// stale signals from previous navigations are ignored.
try {
  const chatId = window.location.pathname.split('/').pop() || '';
  browser.runtime.sendMessage({ type: 'CONTENT_READY', chatId });
} catch (_) {
  // Extension context invalidated (e.g., extension reloaded mid-session).
}
