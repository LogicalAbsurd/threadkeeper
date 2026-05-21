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

  // Step 2: Brief pause for initial render, then scroll-to-top loop.
  await sleep(500);

  const countBefore = document.querySelectorAll('user-query, model-response').length;

  // [DIAG] Log pre-scroll state.
  console.log(`[TK-DIAG] ensureAllMessagesLoaded — ` +
    `scrollTop=${container.scrollTop}, scrollHeight=${container.scrollHeight}, ` +
    `clientHeight=${container.clientHeight}, message count BEFORE=${countBefore}`);

  // Step 3: Iterative lazy-load loop. Gemini's infinite-scroller uses an
  // IntersectionObserver on a sentinel above the topmost rendered message.
  // No single scroll technique reliably fires every batch — but diagnostics
  // showed three techniques that each trigger ONE batch:
  //   (a) container.scrollTop = 0
  //   (b) container.scrollTop = -1000  (overscroll)
  //   (c) scrollIntoView({block:'end'}) on topmost user-query
  // We cycle through all three per iteration. If ANY technique triggers new
  // messages, we restart the next iteration immediately. If a full cycle of
  // all three produces no growth, we increment a "stuck" counter. Two
  // consecutive stuck iterations means we've loaded everything.
  const MAX_ITERATIONS = 100;
  const MAX_TIME = 120000;
  const BATCH_WAIT = 800;
  const STUCK_THRESHOLD = 2;

  let iteration = 0;
  let stuckRuns = 0;
  let lastCount = document.querySelectorAll('user-query').length;
  const startTime = Date.now();

  // [DIAG] Log scroll loop start.
  console.log(`[TK-DIAG] ensureAllMessagesLoaded — starting scroll loop, ` +
    `initial user-query count=${lastCount}, scrollTop=${container.scrollTop}`);

  while (iteration < MAX_ITERATIONS && (Date.now() - startTime) < MAX_TIME) {
    iteration++;

    // --- Technique (a): scrollTop = 0 ---
    container.scrollTop = 0;
    await sleep(BATCH_WAIT);
    let currentCount = document.querySelectorAll('user-query').length;
    console.log(`[TK-DIAG] iteration ${iteration} step (a) scrollTop=0 → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${container.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (a) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue; // new batch loaded, restart iteration
    }

    // --- Technique (b): scrollTop = -1000 (overscroll) ---
    container.scrollTop = -1000;
    await sleep(BATCH_WAIT);
    currentCount = document.querySelectorAll('user-query').length;
    console.log(`[TK-DIAG] iteration ${iteration} step (b) scrollTop=-1000 → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${container.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (b) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // --- Technique (c): topmost user-query scrollIntoView block:'end' ---
    const topmost = container.querySelector('user-query');
    if (topmost) {
      topmost.scrollIntoView({ block: 'end', behavior: 'instant' });
    }
    await sleep(BATCH_WAIT);
    currentCount = document.querySelectorAll('user-query').length;
    console.log(`[TK-DIAG] iteration ${iteration} step (c) scrollIntoView end → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${container.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (c) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // All three techniques failed to grow the count this iteration.
    stuckRuns++;
    console.log(`[TK-DIAG] iteration ${iteration} — no growth, ` +
      `stuckRuns=${stuckRuns}/${STUCK_THRESHOLD}`);
    if (stuckRuns >= STUCK_THRESHOLD) {
      console.log(`[TK-DIAG] ensureAllMessagesLoaded — ` +
        `stuck for ${stuckRuns} consecutive iterations, all messages loaded`);
      break;
    }
  }

  // [DIAG] Log exit reason and final state.
  const totalElapsed = Date.now() - startTime;
  const countAfter = document.querySelectorAll('user-query, model-response').length;
  const reason = stuckRuns >= STUCK_THRESHOLD ? 'STABLE' :
    iteration >= MAX_ITERATIONS ? 'MAX_ITERATIONS' :
    totalElapsed >= MAX_TIME ? 'TIMEOUT' : 'STABLE';

  console.log(`[TK-DIAG] ensureAllMessagesLoaded done — ` +
    `reason=${reason}, iterations=${iteration}, finalCount=${countAfter}, ` +
    `elapsed=${totalElapsed}ms`);

  if (countAfter !== countBefore) {
    console.log(`[TK-DIAG] lazy-load triggered, count went from ${countBefore} to ${countAfter}`);
  } else {
    console.log(`[TK-DIAG] no lazy-load detected, count stayed at ${countAfter}`);
  }

  if (reason !== 'STABLE') {
    console.warn(
      `[Threadkeeper] Scroll ${reason.toLowerCase()} — some older messages may not have loaded. ` +
      `Found ${countAfter} message turns in ${totalElapsed}ms after ${iteration} iterations.`
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


// --- Scroll sidebar until all conversations are lazy-loaded ---

async function ensureAllConversationsLoaded(sidebar) {
  // Gemini's sidebar uses the same infinite-scroller lazy-load pattern as
  // chat history, but scrolling DOWN loads older conversations. Five
  // techniques cycle per iteration (confirmed via diagnostics):
  //   (a) sidebar.scrollTop = sidebar.scrollHeight
  //   (b) sidebar.scrollTop = sidebar.scrollHeight + 1000  (overscroll)
  //   (c) scrollIntoView({block:'start'}) on the last conversation element
  //   (d) "wiggle" — scroll UP 200px then back to bottom (generates two
  //       distinct scroll events, re-engages scroll listeners that ignore
  //       no-op scrollTop assignments when already at the bottom)
  //   (e) dispatch synthetic scroll event on the container
  // Sidebar batches are slower than chat — sometimes 2-3 "empty" iterations
  // between successful loads. Use 4 consecutive stuck iterations as the done
  // signal, BUT only count an iteration as truly stuck if scrollHeight also
  // stopped changing (no new DOM content being appended asynchronously).
  const MAX_ITERATIONS = 100;
  const MAX_TIME = 180000;
  const BATCH_WAIT = 1500;
  const STUCK_THRESHOLD = 4;

  const countConvos = () =>
    document.querySelectorAll('[data-test-id="conversation"]').length;

  let iteration = 0;
  let stuckRuns = 0;
  let lastCount = countConvos();
  const startTime = Date.now();

  // [DIAG] Log scroll loop start.
  console.log(`[TK-DIAG] ensureAllConversationsLoaded — starting scroll loop, ` +
    `initial conversation count=${lastCount}, scrollTop=${sidebar.scrollTop}, ` +
    `scrollHeight=${sidebar.scrollHeight}, clientHeight=${sidebar.clientHeight}`);

  while (iteration < MAX_ITERATIONS && (Date.now() - startTime) < MAX_TIME) {
    iteration++;

    // Snapshot scroll geometry at start of iteration to detect async loading.
    const scrollHeightBefore = sidebar.scrollHeight;
    const scrollTopBefore = sidebar.scrollTop;

    // --- Technique (a): scrollTop = scrollHeight ---
    sidebar.scrollTop = sidebar.scrollHeight;
    await sleep(BATCH_WAIT);
    let currentCount = countConvos();
    console.log(`[TK-DIAG] iteration ${iteration} step (a) scrollTop=scrollHeight → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${sidebar.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (a) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // --- Technique (b): scrollTop = scrollHeight + 1000 (overscroll) ---
    sidebar.scrollTop = sidebar.scrollHeight + 1000;
    await sleep(BATCH_WAIT);
    currentCount = countConvos();
    console.log(`[TK-DIAG] iteration ${iteration} step (b) scrollTop=scrollHeight+1000 → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${sidebar.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (b) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // --- Technique (c): last conversation scrollIntoView block:'start' ---
    const allConvos = document.querySelectorAll('[data-test-id="conversation"]');
    const last = allConvos[allConvos.length - 1];
    if (last) {
      last.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
    await sleep(BATCH_WAIT);
    currentCount = countConvos();
    console.log(`[TK-DIAG] iteration ${iteration} step (c) scrollIntoView start → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${sidebar.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (c) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // --- Technique (d): wiggle — scroll UP 200px then back to bottom ---
    // When scrollTop is already pinned at the bottom, setting it to the
    // same value is a no-op (no scroll event fires). Scrolling up first
    // generates two distinct scroll events and re-engages the listener.
    const savedTop = sidebar.scrollTop;
    sidebar.scrollTop = Math.max(0, savedTop - 200);
    await sleep(300);
    sidebar.scrollTop = sidebar.scrollHeight;
    await sleep(BATCH_WAIT);
    currentCount = countConvos();
    console.log(`[TK-DIAG] iteration ${iteration} step (d) wiggle → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${sidebar.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (d) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // --- Technique (e): dispatch synthetic scroll event ---
    sidebar.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(BATCH_WAIT);
    currentCount = countConvos();
    console.log(`[TK-DIAG] iteration ${iteration} step (e) synthetic scroll → ` +
      `count=${currentCount} (was ${lastCount}), scrollTop=${sidebar.scrollTop}`);
    if (currentCount > lastCount) {
      console.log(`[TK-DIAG] technique (e) triggered batch: ${lastCount} → ${currentCount}`);
      lastCount = currentCount;
      stuckRuns = 0;
      continue;
    }

    // All five techniques failed to grow the count this iteration.
    // Safety net: only count as truly stuck if scrollHeight AND scrollTop
    // are unchanged from the start of this iteration. If either moved, the
    // lazy-loader is still working asynchronously — don't count it.
    const scrollHeightAfter = sidebar.scrollHeight;
    const scrollTopAfter = sidebar.scrollTop;
    const geometryChanged = scrollHeightAfter !== scrollHeightBefore ||
      scrollTopAfter !== scrollTopBefore;

    if (geometryChanged) {
      // Scroll geometry moved but count didn't grow yet — load still in progress.
      console.log(`[TK-DIAG] iteration ${iteration} — no count growth but geometry changed ` +
        `(scrollHeight ${scrollHeightBefore}→${scrollHeightAfter}, ` +
        `scrollTop ${scrollTopBefore}→${scrollTopAfter}), not counting as stuck`);
      // Don't increment stuckRuns, but don't reset it either.
    } else {
      stuckRuns++;
      console.log(`[TK-DIAG] iteration ${iteration} — no growth, geometry unchanged, ` +
        `stuckRuns=${stuckRuns}/${STUCK_THRESHOLD}`);
    }

    if (stuckRuns >= STUCK_THRESHOLD) {
      console.log(`[TK-DIAG] ensureAllConversationsLoaded — ` +
        `stuck for ${stuckRuns} consecutive iterations, all conversations loaded`);
      break;
    }
  }

  // [DIAG] Log exit reason and final state.
  const totalElapsed = Date.now() - startTime;
  const finalCount = countConvos();
  const reason = stuckRuns >= STUCK_THRESHOLD ? 'STABLE' :
    iteration >= MAX_ITERATIONS ? 'MAX_ITERATIONS' :
    totalElapsed >= MAX_TIME ? 'TIMEOUT' : 'STABLE';

  console.log(`[TK-DIAG] ensureAllConversationsLoaded done — ` +
    `reason=${reason}, iterations=${iteration}, finalCount=${finalCount}, ` +
    `elapsed=${totalElapsed}ms`);

  if (reason !== 'STABLE') {
    console.warn(
      `[Threadkeeper] Sidebar scroll ${reason.toLowerCase()} — may have missed older conversations. ` +
      `Found ${finalCount} conversations in ${totalElapsed}ms after ${iteration} iterations.`
    );
  }
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

  // Find the sidebar infinite-scroller. There are TWO infinite-scrollers on
  // the page — one for chat history (data-test-id="chat-history-container")
  // and one for the sidebar conversation list (the one WITHOUT that test-id).
  // We want the sidebar one.
  const sidebarScroller =
    [...document.querySelectorAll('infinite-scroller')]
      .find(el => el.getAttribute('data-test-id') !== 'chat-history-container') ||
    document.querySelector('[data-test-id="all-conversations"]') ||
    document.querySelector('[data-test-id="sidebar-scroller"]');

  if (!sidebarScroller) {
    console.error(`[TK-DIAG] listConversations — no sidebar scroller found`);
    return [];
  }

  console.log(`[TK-DIAG] listConversations — sidebar scroller found: ` +
    `<${sidebarScroller.tagName.toLowerCase()}> data-test-id="${sidebarScroller.getAttribute('data-test-id') || '(none)'}"`);

  // Scroll sidebar until all conversations are lazy-loaded.
  await ensureAllConversationsLoaded(sidebarScroller);

  // HIGH stability: data-test-id="conversation" on <gem-nav-list-item> elements.
  const items = document.querySelectorAll('[data-test-id="conversation"]');
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

  console.log(`[TK-DIAG] listConversations — returning ${conversations.length} conversations`);
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
