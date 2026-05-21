// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

const params = new URLSearchParams(location.search);
const MODE   = params.get('mode');   // 'all' | 'select'
const TAB_ID = parseInt(params.get('tabId'), 10);

// Section references
const sectionConfig   = document.getElementById('section-config');
const sectionLoading  = document.getElementById('section-loading');
const sectionList     = document.getElementById('section-list');
const sectionProgress = document.getElementById('section-progress');
const sectionComplete = document.getElementById('section-complete');

const ALL_SECTIONS = [sectionConfig, sectionLoading, sectionList, sectionProgress, sectionComplete];

let allConversations = [];
let selectedIds = new Set();
let progressListener = null;
let elapsedInterval = null;
// Track previous completed+failed count to detect new log entries.
let prevDoneCount = 0;


// --- Section visibility ---

function showSection(el) { el.hidden = false; }
function hideSection(el) { el.hidden = true; }
function showOnly(...sections) {
  ALL_SECTIONS.forEach((s) => { s.hidden = true; });
  sections.forEach((s) => { s.hidden = false; });
}


// --- Init ---

async function init() {
  await setSiteBadge();

  // Check if an export is already running (page reload / navigate back).
  const state = await browser.runtime.sendMessage({ type: 'GET_EXPORT_STATE' });
  if (state.phase === 'running' || state.phase === 'paused') {
    showOnly(sectionProgress);
    applyProgressState(state);
    startListeningForProgress();
    startElapsedTimer(state.startTime);
    return;
  }
  if (state.phase === 'complete' || state.phase === 'cancelled') {
    showOnly(sectionComplete);
    applyCompletionState(state);
    return;
  }

  // Fresh start: show config + loading, fetch conversation list.
  showSection(sectionConfig);
  showSection(sectionLoading);
  await loadPreferences();

  let conversations;
  try {
    const response = await browser.runtime.sendMessage({
      type: 'LIST_CONVERSATIONS',
      tabId: TAB_ID,
    });
    if (!response?.ok) throw new Error(response?.error || 'Failed to list conversations');
    conversations = response.data;
  } catch (err) {
    document.getElementById('loading-message').textContent =
      `Failed to load conversations: ${err.message}`;
    return;
  }

  allConversations = conversations;
  hideSection(sectionLoading);
  renderChatList(conversations, MODE === 'all');
  showSection(sectionList);
}

init();


// --- Site badge ---

async function setSiteBadge() {
  try {
    const tab = await browser.tabs.get(TAB_ID);
    const url = new URL(tab.url);
    const badge = document.getElementById('site-badge');
    if (url.hostname.includes('gemini.google.com')) {
      badge.textContent = 'Gemini'; badge.className = 'site-badge gemini';
    } else if (url.hostname.includes('chatgpt.com')) {
      badge.textContent = 'ChatGPT'; badge.className = 'site-badge chatgpt';
    } else if (url.hostname.includes('claude.ai')) {
      badge.textContent = 'Claude'; badge.className = 'site-badge claude';
    }
  } catch (_) {
    // Tab may have been closed.
  }
}


// --- Chat list rendering ---

function renderChatList(conversations, autoSelectAll) {
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  selectedIds.clear();

  for (const conv of conversations) {
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.dataset.id = conv.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `chk-${conv.id}`;
    checkbox.checked = autoSelectAll;
    if (autoSelectAll) selectedIds.add(conv.id);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(conv.id);
      else selectedIds.delete(conv.id);
      updateExportBar();
    });

    const label = document.createElement('label');
    label.htmlFor = `chk-${conv.id}`;
    label.textContent = conv.title;
    label.className = 'chat-item-label';

    item.appendChild(checkbox);
    item.appendChild(label);
    list.appendChild(item);
  }

  updateExportBar();
}

function updateExportBar() {
  const n = selectedIds.size;
  document.getElementById('selected-count').textContent = `${n} selected`;
  const btn = document.getElementById('btn-start-export');
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `Export ${n} chat${n === 1 ? '' : 's'}` : 'Export';
  document.getElementById('warning-large').hidden = n <= 200;
}


// --- Filter ---

document.getElementById('filter-input').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  const list = document.getElementById('chat-list');
  for (const item of list.children) {
    const title = allConversations.find((c) => c.id === item.dataset.id)?.title || '';
    item.hidden = !title.toLowerCase().includes(query);
  }
});


// --- Select All / None / Invert ---

document.getElementById('btn-select-all').addEventListener('click', () => {
  for (const cb of document.querySelectorAll('.chat-item:not([hidden]) input[type="checkbox"]')) {
    cb.checked = true;
    selectedIds.add(cb.closest('.chat-item').dataset.id);
  }
  updateExportBar();
});

document.getElementById('btn-select-none').addEventListener('click', () => {
  for (const cb of document.querySelectorAll('.chat-item:not([hidden]) input[type="checkbox"]')) {
    cb.checked = false;
    selectedIds.delete(cb.closest('.chat-item').dataset.id);
  }
  updateExportBar();
});

document.getElementById('btn-select-invert').addEventListener('click', () => {
  for (const cb of document.querySelectorAll('.chat-item:not([hidden]) input[type="checkbox"]')) {
    cb.checked = !cb.checked;
    const id = cb.closest('.chat-item').dataset.id;
    if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
  }
  updateExportBar();
});


// --- Start export ---

document.getElementById('btn-start-export').addEventListener('click', async () => {
  const chatIds = [...selectedIds];
  if (chatIds.length === 0) return;

  const format = document.querySelector('input[name="format"]:checked').value;
  const outputMode = document.querySelector('input[name="output"]:checked').value;

  if (chatIds.length > 50) {
    const minutes = Math.ceil(chatIds.length * 0.5 / 60);
    const ok = confirm(
      `You're about to export ${chatIds.length} conversations. ` +
      `This will take approximately ${minutes} minute${minutes === 1 ? '' : 's'}. Continue?`
    );
    if (!ok) return;
  }

  const response = await browser.runtime.sendMessage({
    type: 'START_BULK_EXPORT',
    tabId: TAB_ID,
    chatIds,
    format,
    outputMode,
  });

  if (!response?.ok) {
    alert(`Failed to start export: ${response?.error}`);
    return;
  }

  prevDoneCount = 0;
  showOnly(sectionConfig, sectionProgress);
  startListeningForProgress();
  startElapsedTimer(new Date().toISOString());
});


// --- Progress ---

function startListeningForProgress() {
  if (progressListener) browser.runtime.onMessage.removeListener(progressListener);

  progressListener = (message) => {
    if (message.type !== 'EXPORT_PROGRESS') return;
    applyProgressState(message.state);
    if (message.state.phase === 'complete' || message.state.phase === 'cancelled') {
      browser.runtime.onMessage.removeListener(progressListener);
      progressListener = null;
      clearInterval(elapsedInterval);
      showSection(sectionComplete);
      applyCompletionState(message.state);
    }
  };

  browser.runtime.onMessage.addListener(progressListener);
}

function applyProgressState(state) {
  const { total, currentIndex, currentTitle, completedCount, failedCount, phase } = state;
  const done = completedCount + failedCount;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  document.getElementById('progress-bar-fill').style.width = `${pct}%`;
  document.getElementById('progress-counts').textContent =
    `${done} / ${total}` + (failedCount > 0 ? ` — ${failedCount} failed` : '');
  document.getElementById('progress-current').textContent =
    currentTitle ? `Current: ${currentTitle}` : 'Preparing\u2026';
  document.getElementById('progress-phase-label').textContent =
    phase === 'paused' ? 'Paused' : 'Exporting\u2026';
  document.getElementById('btn-pause').textContent =
    phase === 'paused' ? 'Resume' : 'Pause';

  // Append log entries for newly completed/failed items.
  if (done > prevDoneCount && currentTitle) {
    const log = document.getElementById('progress-log');
    const entry = document.createElement('p');
    entry.textContent = `${currentTitle}`;
    log.prepend(entry);
    prevDoneCount = done;
  }
}

function startElapsedTimer(startTimeISO) {
  const startMs = new Date(startTimeISO).getTime();
  clearInterval(elapsedInterval);
  const tick = () => {
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = String(elapsed % 60).padStart(2, '0');
    document.getElementById('progress-time').textContent = `${m}:${s} elapsed`;
  };
  tick();
  elapsedInterval = setInterval(tick, 1000);
}


// --- Pause / Cancel ---

document.getElementById('btn-pause').addEventListener('click', async () => {
  const btn = document.getElementById('btn-pause');
  if (btn.textContent === 'Pause') {
    await browser.runtime.sendMessage({ type: 'PAUSE_EXPORT' });
  } else {
    await browser.runtime.sendMessage({ type: 'RESUME_EXPORT' });
  }
});

document.getElementById('btn-cancel').addEventListener('click', async () => {
  if (!confirm('Cancel the export? Progress so far will be kept.')) return;
  await browser.runtime.sendMessage({ type: 'CANCEL_EXPORT' });
});


// --- Completion ---

function applyCompletionState(state) {
  const { completedCount, failedCount, failed, phase } = state;
  const summary = document.getElementById('summary-text');

  if (phase === 'cancelled') {
    summary.textContent =
      `Export cancelled. ${completedCount} conversation${completedCount === 1 ? '' : 's'} exported before cancellation.`;
  } else {
    summary.textContent =
      `${completedCount} conversation${completedCount === 1 ? '' : 's'} exported successfully.` +
      (failedCount > 0 ? ` ${failedCount} failed.` : '');
  }

  const failedList = document.getElementById('failed-list');
  const retryBtn = document.getElementById('btn-retry-failed');

  if (failedCount > 0 && failed) {
    failedList.hidden = false;
    retryBtn.hidden = false;
    failedList.innerHTML =
      '<p class="failed-header">Failed conversations:</p>' +
      failed.map((f) => `<p class="failed-item">${f.title}: ${f.error}</p>`).join('');
  } else {
    failedList.hidden = true;
    retryBtn.hidden = true;
  }
}

document.getElementById('btn-retry-failed').addEventListener('click', async () => {
  const response = await browser.runtime.sendMessage({ type: 'RETRY_FAILED' });
  if (!response?.ok) {
    alert(`Retry failed: ${response?.error}`);
    return;
  }
  document.getElementById('failed-list').hidden = true;
  document.getElementById('btn-retry-failed').hidden = true;
  prevDoneCount = 0;
  showOnly(sectionConfig, sectionProgress);
  startListeningForProgress();
  startElapsedTimer(new Date().toISOString());
});

document.getElementById('btn-new-export').addEventListener('click', () => {
  location.reload();
});


// --- Preferences ---

async function loadPreferences() {
  const stored = await browser.storage.local.get(['format', 'outputMode']);
  if (stored.format) {
    const radio = document.querySelector(`input[name="format"][value="${stored.format}"]`);
    if (radio) radio.checked = true;
  }
  if (stored.outputMode) {
    const radio = document.querySelector(`input[name="output"][value="${stored.outputMode}"]`);
    if (radio) radio.checked = true;
  }

  for (const radio of document.querySelectorAll('input[name="format"], input[name="output"]')) {
    radio.addEventListener('change', () => {
      browser.storage.local.set({
        format: document.querySelector('input[name="format"]:checked')?.value,
        outputMode: document.querySelector('input[name="output"]:checked')?.value,
      });
    });
  }
}
