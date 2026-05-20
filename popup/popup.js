// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

const SUPPORTED_SITES = [
  { key: 'gemini',  label: 'Gemini',  pattern: 'gemini.google.com' },
  { key: 'chatgpt', label: 'ChatGPT', pattern: 'chatgpt.com' },
  { key: 'claude',  label: 'Claude',  pattern: 'claude.ai' },
];

const $ = (sel) => document.querySelector(sel);

async function detectSite() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;

  const url = new URL(tab.url);
  return SUPPORTED_SITES.find((s) => url.hostname.endsWith(s.pattern)) ?? null;
}

function getSelectedFormat() {
  return document.querySelector('input[name="format"]:checked').value;
}

async function init() {
  const site = await detectSite();

  if (site) {
    const badge = $('#site-badge');
    badge.textContent = site.label;
    badge.classList.add(site.key);
    $('#actions').hidden = false;
  } else {
    $('#unsupported-msg').hidden = false;
  }

  // --- Action buttons ---

  $('#btn-export-current').addEventListener('click', async () => {
    const btn = $('#btn-export-current');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Exporting\u2026';

    try {
      const response = await browser.runtime.sendMessage({
        type: 'EXPORT_CURRENT',
        format: getSelectedFormat(),
      });

      if (response?.ok) {
        btn.textContent = 'Exported!';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
      } else {
        console.error('[Threadkeeper]', response?.error);
        btn.textContent = 'Export failed';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      console.error('[Threadkeeper] sendMessage error:', err);
      btn.textContent = 'Export failed';
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
    }
  });

  $('#btn-export-all').addEventListener('click', async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const url = browser.runtime.getURL('export/export.html') +
      `?mode=all&tabId=${tab.id}`;
    await browser.tabs.create({ url });
    window.close();
  });

  $('#btn-export-select').addEventListener('click', async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const url = browser.runtime.getURL('export/export.html') +
      `?mode=select&tabId=${tab.id}`;
    await browser.tabs.create({ url });
    window.close();
  });

  // --- Settings pane toggle ---

  $('#btn-settings').addEventListener('click', () => {
    const pane = $('#settings-pane');
    pane.hidden = !pane.hidden;
  });

  $('#btn-settings-close').addEventListener('click', () => {
    $('#settings-pane').hidden = true;
  });

  // --- Persist preferences in storage ---

  const stored = await browser.storage.local.get(['format', 'bulkDelay']);
  if (stored.format) {
    const radio = document.querySelector(`input[name="format"][value="${stored.format}"]`);
    if (radio) radio.checked = true;
  }
  if (stored.bulkDelay != null) {
    $('#setting-delay').value = stored.bulkDelay;
  }

  document.querySelectorAll('input[name="format"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      browser.storage.local.set({ format: getSelectedFormat() });
    });
  });

  $('#setting-delay').addEventListener('change', () => {
    const val = parseInt($('#setting-delay').value, 10);
    if (Number.isFinite(val) && val >= 0) {
      browser.storage.local.set({ bulkDelay: val });
    }
  });
}

init();
