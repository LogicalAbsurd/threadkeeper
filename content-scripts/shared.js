// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

// ============================================================================
// Message protocol — popup, export page, background, content scripts.
//
// --- Popup / Export page → Background ---
//   { type: 'EXPORT_CURRENT', format }
//     → { ok: true } | { ok: false, error }
//
//   { type: 'LIST_CONVERSATIONS', tabId }
//     → { ok: true, data: [{id, title, url}] } | { ok: false, error }
//     Background forwards to the content script on the given tab.
//
//   { type: 'START_BULK_EXPORT', tabId, chatIds, format, outputMode }
//     format: 'markdown' | 'json' | 'both'
//     outputMode: 'individual' | 'combined' | 'both'
//     → { ok: true } | { ok: false, error }
//
//   { type: 'PAUSE_EXPORT' }   → { ok: true }
//   { type: 'RESUME_EXPORT' }  → { ok: true }
//   { type: 'CANCEL_EXPORT' }  → { ok: true }
//   { type: 'RETRY_FAILED' }   → { ok: true }
//   { type: 'GET_EXPORT_STATE' } → exportState summary object
//
// --- Background → Content script ---
//   { type: 'PARSE_CURRENT' }
//     → { ok, data: { title, site, url, exportedAt, messages } }
//
//   { type: 'LIST_CONVERSATIONS' }
//     → { ok, data: [{id, title, url}] }
//
// --- Content script → Background (one-way, no response) ---
//   { type: 'CONTENT_READY', chatId }
//     Sent at top level on every page load. chatId is extracted from the URL.
//     Background only acts on this when actively waiting for a specific chatId
//     during bulk export navigation — stale messages are ignored.
//
// --- Background → Export page (broadcast, no response expected) ---
//   { type: 'EXPORT_PROGRESS', state: exportStateSummary }
//     Sent after each conversation completes and on phase changes.
//
// The normalized message shape inside data.messages:
//   { role: 'user' | 'assistant', content: string, timestamp?: string }
// ============================================================================


// --- Utilities ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// --- HTML-to-Markdown converter ---
//
// Recursively walks a DOM element and returns a Markdown string.
// Used by all site scrapers to convert rendered assistant HTML into Markdown.
// Lives here (not in lib/) because it needs DOM access.

function htmlToMarkdown(node) {
  return _walkNode(node, { listDepth: 0, ordered: false }).trim();
}

function _walkNode(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent;
    return ctx.insidePre ? text : text.replace(/\s+/g, ' ');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();

  // --- Block elements ---

  if (tag === 'pre') {
    return _handlePre(node);
  }

  if (tag === 'p') {
    const inner = _walkChildren(node, ctx);
    return inner ? `\n\n${inner}` : '';
  }

  if (/^h([1-6])$/.test(tag)) {
    const level = parseInt(tag[1], 10);
    const inner = _walkChildren(node, ctx).trim();
    return inner ? `\n\n${'#'.repeat(level)} ${inner}` : '';
  }

  if (tag === 'blockquote') {
    const inner = _walkChildren(node, ctx).trim();
    const quoted = inner.split('\n').map((l) => `> ${l}`).join('\n');
    return `\n\n${quoted}`;
  }

  if (tag === 'ul' || tag === 'ol') {
    return _handleList(node, tag === 'ol', ctx);
  }

  if (tag === 'li') {
    return _handleListItem(node, ctx);
  }

  if (tag === 'table') {
    return _handleTable(node);
  }

  if (tag === 'br') {
    return '\n';
  }

  if (tag === 'hr') {
    return '\n\n---';
  }

  // --- Inline elements ---

  if (tag === 'strong' || tag === 'b') {
    const inner = _walkChildren(node, ctx);
    return inner ? `**${inner}**` : '';
  }

  if (tag === 'em' || tag === 'i') {
    const inner = _walkChildren(node, ctx);
    return inner ? `_${inner}_` : '';
  }

  if (tag === 'code') {
    // Inline code (not inside <pre>). If inside <pre>, _handlePre takes over.
    const text = node.textContent;
    return text ? `\`${text}\`` : '';
  }

  if (tag === 'a') {
    const inner = _walkChildren(node, ctx);
    const href = node.getAttribute('href') || '';
    if (!href || href.startsWith('javascript:')) return inner;
    return `[${inner}](${href})`;
  }

  if (tag === 'img') {
    const alt = node.getAttribute('alt');
    return alt ? `[image: ${alt}]` : '[image]';
  }

  // --- Transparent wrappers (div, span, section, etc.) ---
  return _walkChildren(node, ctx);
}

function _walkChildren(node, ctx) {
  let result = '';
  for (const child of node.childNodes) {
    result += _walkNode(child, ctx);
  }
  return result;
}

function _handlePre(preEl) {
  const codeEl = preEl.querySelector('code');
  const text = (codeEl || preEl).textContent;

  // Language hint: try the decoration element that Gemini places near code blocks.
  // FRAGILE: .code-block-decoration is a styling class — may break on redesign.
  let lang = '';
  const decoration = preEl.closest('.code-block')
    ?.querySelector('.code-block-decoration span');
  if (decoration) {
    lang = decoration.textContent.trim().toLowerCase();
  }
  if (!lang && codeEl) {
    // Fallback: language-* class on the <code> element (common convention).
    const langClass = [...codeEl.classList].find((c) => c.startsWith('language-'));
    if (langClass) lang = langClass.replace('language-', '');
  }

  return `\n\n\`\`\`${lang}\n${text}\n\`\`\``;
}

function _handleList(listEl, ordered, ctx) {
  const childCtx = { ...ctx, listDepth: ctx.listDepth + 1, ordered };
  let result = '';
  let index = 1;
  for (const child of listEl.children) {
    if (child.tagName.toLowerCase() === 'li') {
      result += _handleListItem(child, { ...childCtx, listIndex: index++ });
    }
  }
  // Only add leading newlines if this is a top-level list (not nested).
  return ctx.listDepth === 0 ? `\n\n${result}` : `\n${result}`;
}

function _handleListItem(liEl, ctx) {
  const indent = '  '.repeat(Math.max(0, ctx.listDepth - 1));
  const marker = ctx.ordered ? `${ctx.listIndex}.` : '-';
  const inner = _walkChildren(liEl, ctx).trim();
  return `${indent}${marker} ${inner}\n`;
}

function _handleTable(tableEl) {
  const rows = [];
  for (const tr of tableEl.querySelectorAll('tr')) {
    const cells = [...tr.querySelectorAll('th, td')]
      .map((cell) => _walkChildren(cell, { listDepth: 0 }).trim());
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const lines = [];

  // Header row (first row or synthesize from column count).
  const header = rows[0] || new Array(colCount).fill('');
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');

  // Data rows.
  for (let i = 1; i < rows.length; i++) {
    // Pad row to colCount if needed.
    while (rows[i].length < colCount) rows[i].push('');
    lines.push('| ' + rows[i].join(' | ') + ' |');
  }

  return '\n\n' + lines.join('\n');
}
