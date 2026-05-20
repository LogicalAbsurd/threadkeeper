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

  // --- Action buttons (stub — log intent, no scraping yet) ---

  $('#btn-export-current').addEventListener('click', () => {
    console.log(`[Chat Archiver] Export current chat as ${getSelectedFormat()} from ${site.label}`);
  });

  $('#btn-export-all').addEventListener('click', () => {
    console.log(`[Chat Archiver] Export all chats as ${getSelectedFormat()} from ${site.label}`);
  });

  $('#btn-export-select').addEventListener('click', () => {
    console.log(`[Chat Archiver] Select chats to export as ${getSelectedFormat()} from ${site.label}`);
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
