// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)
//
// Portions adapted from chatgpt-exporter by Pionxzh (MIT)
// https://github.com/pionxzh/chatgpt-exporter

'use strict';

// ChatGPT scraper — content script for chatgpt.com.
// Uses ChatGPT's internal backend API (same-origin, user's authenticated session)
// rather than DOM scraping. Loaded after shared.js, so sleep() is available.

const API_BASE = '/backend-api';
const SESSION_URL = '/api/auth/session';
const PAGE_SIZE = 100;

// --- Session token management ---
// Content scripts run in an isolated world and cannot access page JS globals
// like __remixContext. Instead, we fetch the token from ChatGPT's session
// endpoint, which is cookie-authenticated (same-origin, no CORS issues).

let _cachedToken = null;

async function fetchSessionToken() {
  const res = await fetch(SESSION_URL);
  if (!res.ok) throw new Error(`Session fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.accessToken) throw new Error('No accessToken in session response');
  return data.accessToken;
}

async function getAccessToken() {
  if (_cachedToken) return _cachedToken;
  _cachedToken = await fetchSessionToken();
  return _cachedToken;
}

// Clear cached token so next call re-fetches (used on 401).
function clearTokenCache() {
  _cachedToken = null;
}


// --- Authenticated fetch wrapper ---

async function fetchApi(url, retryOn401 = true) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-Authorization': `Bearer ${token}`,
    },
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
    const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30;
    console.warn(`[Threadkeeper] ChatGPT API rate limited, waiting ${waitSec}s`);
    await sleep(waitSec * 1000);
    // Retry once after waiting.
    return fetchApi(url, false);
  }

  if (res.status === 401 && retryOn401) {
    // Token may have expired — clear cache and retry once.
    clearTokenCache();
    return fetchApi(url, false);
  }

  if (!res.ok) {
    throw new Error(`ChatGPT API ${res.status}: ${res.statusText} (${url})`);
  }

  return res.json();
}


// --- Conversation list (offset-paginated) ---

async function _paginateConversations(isArchived) {
  const allItems = [];
  let offset = 0;
  const label = isArchived ? 'archived' : 'active';

  console.log(`[TK-DIAG] _paginateConversations(${label}) — starting paginated fetch`);

  while (true) {
    const url = `${API_BASE}/conversations?offset=${offset}&limit=${PAGE_SIZE}` +
      (isArchived ? '&is_archived=true' : '');
    const data = await fetchApi(url);
    const items = data.items || [];

    console.log(`[TK-DIAG] _paginateConversations(${label}) — offset=${offset}, ` +
      `got ${items.length} items, total=${data.total ?? '(unknown)'}`);

    for (const item of items) {
      let createdAt;
      if (item.create_time) {
        const ms = item.create_time * 1000;
        if (Number.isFinite(ms)) {
          const d = new Date(ms);
          if (!Number.isNaN(d.getTime())) {
            createdAt = d.toISOString();
          }
        }
      }
      allItems.push({
        id: item.id,
        title: item.title || 'Untitled',
        url: `https://chatgpt.com/c/${item.id}`,
        createdAt,
      });
    }

    offset += items.length;

    // Stop when we've fetched everything or the API returns an empty page.
    if (items.length === 0) break;
    if (data.total != null && offset >= data.total) break;
  }

  console.log(`[TK-DIAG] _paginateConversations(${label}) — done, ${allItems.length} items`);
  return allItems;
}

async function listConversations({ includeArchived = false } = {}) {
  const active = await _paginateConversations(false);
  if (!includeArchived) return active;

  const archived = await _paginateConversations(true);
  console.log(`[TK-DIAG] listConversations — ${active.length} active + ${archived.length} archived`);
  return active.concat(archived);
}


// --- Message tree parsing ---

// Walk the mapping from current_node backward via parent links.
// Collect user and assistant messages in chronological order.
function walkMessageTree(mapping, currentNodeId) {
  const result = [];
  let nodeId = currentNodeId;

  while (nodeId) {
    const node = mapping[nodeId];
    if (!node || node.parent === undefined) break;

    const msg = node.message;
    if (msg && msg.content && shouldIncludeMessage(msg)) {
      const role = msg.author?.role === 'user' ? 'user' : 'assistant';
      const content = extractContent(msg);
      const timestamp = msg.create_time
        ? new Date(msg.create_time * 1000).toISOString()
        : undefined;

      if (content.trim()) {
        result.unshift({ role, content: content.trim(), timestamp });
      }
    }

    nodeId = node.parent;
  }

  return result;
}

// Decide whether a message should appear in the export.
function shouldIncludeMessage(msg) {
  const role = msg.author?.role;
  // Skip system messages and tool-internal messages.
  if (role === 'system') return false;
  if (role === 'tool') return false;

  // Skip messages directed to a specific tool (not user-facing).
  if (msg.recipient && msg.recipient !== 'all') return false;

  // Skip empty content.
  if (!msg.content) return false;
  const parts = msg.content.parts;
  if (!parts || parts.length === 0) return false;

  return true;
}

// Extract readable content from a message's content object.
function extractContent(msg) {
  const content = msg.content;
  if (!content) return '';

  const type = content.content_type;

  if (type === 'text') {
    // parts is an array of strings (usually just one).
    const parts = (content.parts || []).filter((p) => typeof p === 'string');
    return parts.join('\n');
  }

  if (type === 'multimodal_text') {
    // Mix of text strings and image/audio objects.
    const pieces = [];
    for (const part of (content.parts || [])) {
      if (typeof part === 'string') {
        pieces.push(part);
      } else if (part && part.content_type === 'image_asset_pointer') {
        pieces.push('[image]');
      } else if (part && part.content_type === 'audio_transcription') {
        pieces.push(`[audio] ${part.text || ''}`);
      }
    }
    return pieces.join('\n');
  }

  if (type === 'code') {
    const text = (content.text || '').trim();
    return text ? '```\n' + text + '\n```' : '';
  }

  if (type === 'execution_output') {
    const text = (content.text || '').trim();
    return text ? `[Code output]\n\`\`\`\n${text}\n\`\`\`` : '[Code execution output]';
  }

  if (type === 'tether_quote' || type === 'tether_browsing_display') {
    const title = content.title || content.domain || '';
    const text = (content.text || '').trim();
    const url = content.url || '';
    let result = '';
    if (title) result += `> **${title}**`;
    if (url) result += ` ([source](${url}))`;
    if (text) result += '\n> ' + text.split('\n').join('\n> ');
    return result || '[web browsing result]';
  }

  // Unknown content type — try to extract text parts anyway.
  const parts = (content.parts || []).filter((p) => typeof p === 'string');
  if (parts.length > 0) return parts.join('\n');

  return '';
}


// --- Fetch and parse a single conversation by ID ---

async function fetchConversationById(chatId) {
  const url = `${API_BASE}/conversation/${chatId}`;
  const conv = await fetchApi(url);

  if (!conv.mapping || !conv.current_node) {
    throw new Error(`Conversation ${chatId} has no message mapping`);
  }

  const messages = walkMessageTree(conv.mapping, conv.current_node);

  return {
    site: 'chatgpt',
    title: conv.title || 'Untitled',
    url: `https://chatgpt.com/c/${chatId}`,
    exportedAt: new Date().toISOString(),
    messages,
  };
}


// --- Parse current page's conversation ---

function getChatIdFromUrl() {
  // Matches: /c/{id}, /g/{gpt-id}/c/{id}
  const match = location.pathname.match(/\/c\/([a-z0-9-]+)/i);
  return match ? match[1] : null;
}

async function parseMessages() {
  const chatId = getChatIdFromUrl();
  if (!chatId) {
    throw new Error('Not on a ChatGPT conversation page');
  }

  console.log(`[TK-DIAG] parseMessages — fetching conversation ${chatId} via API`);
  const data = await fetchConversationById(chatId);
  console.log(`[TK-DIAG] parseMessages — got ${data.messages.length} messages`);

  return data.messages;
}

function getTitle() {
  const chatId = getChatIdFromUrl();
  if (!chatId) return 'Untitled conversation';

  // Page title is usually "ChatGPT" or "ChatGPT - <title>".
  const pageTitle = document.title.replace(/^ChatGPT\s*[-–—]\s*/i, '').trim();
  if (pageTitle && pageTitle !== 'ChatGPT') return pageTitle;

  return 'Untitled conversation';
}


// --- Message listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'PARSE_CURRENT') {
    return (async () => {
      try {
        const chatId = getChatIdFromUrl();
        if (!chatId) {
          return { ok: false, error: 'Not on a ChatGPT conversation page' };
        }

        const data = await fetchConversationById(chatId);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'LIST_CONVERSATIONS') {
    return (async () => {
      try {
        const data = await listConversations({ includeArchived: message.includeArchived });
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'FETCH_CONVERSATION') {
    return (async () => {
      try {
        const data = await fetchConversationById(message.chatId);
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }
});


// --- CONTENT_READY signal ---

try {
  const chatId = getChatIdFromUrl() || '';
  console.log(`[TK-DIAG] CONTENT_READY firing — chatId="${chatId}", url="${window.location.href}"`);
  browser.runtime.sendMessage({ type: 'CONTENT_READY', chatId });
} catch (_) {
  // Extension context invalidated.
}
