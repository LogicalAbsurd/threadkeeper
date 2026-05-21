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
  // Step 1: Wait for the chat scroll container to appear in the DOM.
  // After navigation, Angular takes 1-2s to hydrate and render the
  // <infinite-scroller data-test-id="chat-history-container"> element.
  // Poll every 100ms, cap at 5s. There are TWO infinite-scrollers in
  // Gemini's DOM (sidebar + chat) — qualify by data-test-id to avoid
  // matching the sidebar one.
  const CONTAINER_POLL = 100;
  const CONTAINER_MAX = 5000;

  // HIGH stability: data-test-id from Google's test infra on the chat scroller.
  const containerSelectors = [
    '[data-test-id="chat-history-container"]',
    'infinite-scroller[data-test-id="chat-history-container"]',
    '.chat-history',
  ];

  let container = null;
  let matchedSelector = '(none)';
  let containerElapsed = 0;

  while (!container && containerElapsed < CONTAINER_MAX) {
    for (const sel of containerSelectors) {
      const el = document.querySelector(sel);
      if (el) { container = el; matchedSelector = sel; break; }
    }
    if (!container) {
      await sleep(CONTAINER_POLL);
      containerElapsed += CONTAINER_POLL;
    }
  }

  // [DIAG] Log container discovery result.
  if (container) {
    console.log(`[TK-DIAG] ensureAllMessagesLoaded — ` +
      `container="${matchedSelector}" found after ${containerElapsed}ms`);
  } else {
    console.error(`[TK-DIAG] ensureAllMessagesLoaded — ` +
      `no chat scroll container found after ${CONTAINER_MAX}ms. ` +
      `Tried: ${containerSelectors.join(', ')}. Aborting scrape.`);
    return;
  }

  // Step 2: Scroll to top, then poll for lazy-loaded messages.
  // Gemini preserves scroll position on SPA navigation. We must scroll to 0
  // to trigger lazy-load of older messages, then keep scrolling back to 0
  // each time new messages appear (lazy-load inserts above the viewport).
  const countBefore = document.querySelectorAll('user-query, model-response').length;
  const scrollTopBefore = container.scrollTop;

  // [DIAG] Log pre-scroll state.
  console.log(`[TK-DIAG] ensureAllMessagesLoaded — ` +
    `scrollTop BEFORE=${scrollTopBefore}, scrollHeight=${container.scrollHeight}, ` +
    `clientHeight=${container.clientHeight}, message count BEFORE=${countBefore}`);

  container.scrollTop = 0;

  await sleep(100);
  const scrollTopAfterInitial = container.scrollTop;
  // [DIAG] Log whether initial scroll took effect.
  console.log(`[TK-DIAG] ensureAllMessagesLoaded — ` +
    `scrollTop AFTER set to 0 (100ms later)=${scrollTopAfterInitial}, ` +
    `did scroll=${scrollTopBefore !== scrollTopAfterInitial}`);

  // Three-phase polling:
  //   Phase 1 — wait for at least 1 message element (SPA hydration).
  //   Phase 2 — scroll to top, wait for count to stabilise across 3 polls.
  //             If count changes, re-scroll to 0 (lazy-load added older messages
  //             above the viewport) and restart the stable countdown.
  //   Phase 3 — stable for 750ms with count > 0: done.
  const INITIAL_WAIT = 300;
  const POLL_INTERVAL = 250;
  const STABLE_THRESHOLD = 3;
  const MAX_WAIT = 30000;

  await sleep(INITIAL_WAIT);
  let elapsed = INITIAL_WAIT;

  let stableCount = 0;
  let lastMessageCount = -1;

  while (stableCount < STABLE_THRESHOLD && elapsed < MAX_WAIT) {
    await sleep(POLL_INTERVAL);
    elapsed += POLL_INTERVAL;

    const current = document.querySelectorAll('user-query, model-response').length;
    // [DIAG] Log each stability poll.
    console.log(`[TK-DIAG] ensureAllMessagesLoaded poll — ` +
      `elapsed=${elapsed}ms, count=${current}, lastCount=${lastMessageCount}, ` +
      `stable=${stableCount}/${STABLE_THRESHOLD}, scrollTop=${container.scrollTop}`);

    // Phase 1: no messages yet — keep waiting, don't start the stable countdown.
    if (current === 0) {
      stableCount = 0;
      lastMessageCount = 0;
      continue;
    }

    // Phase 2: messages exist — run the stability check.
    if (current === lastMessageCount) {
      stableCount++;
    } else {
      // Count changed — lazy-load likely added older messages above viewport.
      // Re-scroll to top so the next batch loads too.
      container.scrollTop = 0;
      // [DIAG]
      console.log(`[TK-DIAG] ensureAllMessagesLoaded — ` +
        `count changed ${lastMessageCount} → ${current}, re-scrolling to top`);
      stableCount = 0;
      lastMessageCount = current;
    }
  }

  // [DIAG] Log exit reason and whether lazy-load changed the count.
  const countAfter = document.querySelectorAll('user-query, model-response').length;
  const reason = elapsed >= MAX_WAIT ? 'TIMEOUT' : 'STABLE';
  console.log(`[TK-DIAG] ensureAllMessagesLoaded done — ` +
    `reason=${reason}, finalCount=${lastMessageCount}, elapsed=${elapsed}ms`);
  if (countAfter !== countBefore) {
    console.log(`[TK-DIAG] lazy-load triggered, count went from ${countBefore} to ${countAfter}`);
  } else {
    console.log(`[TK-DIAG] no lazy-load detected, count stayed at ${countAfter}`);
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
  // [DIAG] Log state BEFORE ensureAllMessagesLoaded.
  console.log(`[TK-DIAG] parseMessages() called — url="${window.location.href}", ` +
    `user-query=${document.querySelectorAll('user-query').length}, ` +
    `model-response=${document.querySelectorAll('model-response').length}`);

  await ensureAllMessagesLoaded();

  // user-query and model-response are Angular custom elements — HIGH stability.
  // They're part of Gemini's component registration, not styling classes.
  const turns = document.querySelectorAll('user-query, model-response');

  // [DIAG] Log state AFTER ensureAllMessagesLoaded.
  console.log(`[TK-DIAG] parseMessages() after ensureAllMessagesLoaded — ` +
    `turns found=${turns.length}, url="${window.location.href}"`);
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
  // [DIAG] Log when CONTENT_READY fires and what URL we're on.
  console.log(`[TK-DIAG] CONTENT_READY firing — chatId="${chatId}", url="${window.location.href}", ` +
    `user-query count=${document.querySelectorAll('user-query').length}, ` +
    `model-response count=${document.querySelectorAll('model-response').length}`);
  browser.runtime.sendMessage({ type: 'CONTENT_READY', chatId });
} catch (_) {
  // Extension context invalidated (e.g., extension reloaded mid-session).
}
