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
        console.error('[Chat Archiver]', response?.error);
        btn.textContent = 'Export failed';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      console.error('[Chat Archiver] sendMessage error:', err);
      btn.textContent = 'Export failed';
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
    }
  });

  // Stubs — bulk and selective export are Phase 4.
  $('#btn-export-all').addEventListener('click', () => {
    console.log(`[Chat Archiver] Export all chats as ${getSelectedFormat()} — not yet implemented`);
  });

  $('#btn-export-select').addEventListener('click', () => {
    console.log(`[Chat Archiver] Select chats to export as ${getSelectedFormat()} — not yet implemented`);
  });

  // --- Settings pane toggle ---

  $('#btn-settings').addEventListener('click', () => {
    const pane = $('#settings-pane');
    pane.hidden = !pane.hidden;
  });

  $('#btn-settings-close').addEventListener('click', () => {
    $('#settings-pane').hidden = true;
  });

  // --- Persist format preference in storage ---

  const stored = await browser.storage.local.get('format');
  if (stored.format) {
    const radio = document.querySelector(`input[name="format"][value="${stored.format}"]`);
    if (radio) radio.checked = true;
  }

  document.querySelectorAll('input[name="format"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      browser.storage.local.set({ format: getSelectedFormat() });
    });
  });
}

init();
