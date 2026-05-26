// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)
//
// API endpoint patterns adapted from claude-exporter by agoramachina (MIT)
// https://github.com/agoramachina/claude-exporter
// Itself a fork of Claude-Conversation-Exporter by socketteer (MIT)
// https://github.com/socketteer/Claude-Conversation-Exporter

'use strict';

// Claude.ai scraper — content script for claude.ai.
// Uses Claude's internal API (same-origin, user's authenticated session)
// rather than DOM scraping. Loaded after shared.js, so sleep() is available.

const MAX_RETRIES = 3;


// --- Organization ID management ---
// Claude.ai scopes conversations under an organization. We auto-detect the
// org by finding one whose capabilities include "chat", then cache it.

let _cachedOrgId = null;

async function fetchOrgId() {
  const res = await fetch('/api/organizations', {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Org fetch failed: ${res.status} ${res.statusText}`);

  const orgs = await res.json();
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error('No organizations found on Claude.ai account');
  }

  // Prefer org with "chat" capability; fall back to first org.
  const chatOrg = orgs.find((o) =>
    Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  const org = chatOrg || orgs[0];
  const chatCapable = !!chatOrg;

  console.log(`[TK-DIAG] claude: org-id resolved ${org.uuid} (chat-capable: ${chatCapable})`);

  // Cache to storage for persistence across sessions.
  await browser.storage.local.set({ tk_claude_org_id: org.uuid });
  return org.uuid;
}

async function getOrgId() {
  if (_cachedOrgId) return _cachedOrgId;

  // Try storage first.
  const stored = await browser.storage.local.get('tk_claude_org_id');
  if (stored.tk_claude_org_id) {
    _cachedOrgId = stored.tk_claude_org_id;
    console.log(`[TK-DIAG] claude: org-id from cache ${_cachedOrgId}`);
    return _cachedOrgId;
  }

  _cachedOrgId = await fetchOrgId();
  return _cachedOrgId;
}

function clearOrgIdCache() {
  _cachedOrgId = null;
  browser.storage.local.remove('tk_claude_org_id');
}


// --- Authenticated fetch wrapper ---
// All Claude.ai API requests use cookie-based auth via credentials: 'include'.
// No token endpoint needed (unlike ChatGPT).

async function fetchApi(url, retriesLeft = MAX_RETRIES) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' },
  });

  if (res.status === 429) {
    if (retriesLeft <= 0) {
      throw new Error(`Claude API rate limited after ${MAX_RETRIES} retries (${url})`);
    }
    const retryAfter = parseInt(res.headers.get('Retry-After'), 10);
    const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30;
    console.warn(`[TK-DIAG] claude: rate limited, waiting ${waitSec}s`);
    await sleep(waitSec * 1000);
    return fetchApi(url, retriesLeft - 1);
  }

  if (res.status === 401 || res.status === 403) {
    // Session may have expired or org ID may be stale.
    // Clear org cache so the next operation fetches a fresh org ID.
    console.warn(`[TK-DIAG] claude: ${res.status} response, invalidating org cache`);
    clearOrgIdCache();
    throw new Error(
      `Claude API ${res.status}: ${res.statusText}. ` +
      'Try refreshing claude.ai to re-authenticate.'
    );
  }

  if (!res.ok) {
    throw new Error(`Claude API ${res.status}: ${res.statusText} (${url})`);
  }

  return res.json();
}


// --- Date helper (NaN-guarded, same pattern as chatgpt.js) ---

function safeISO(dateStr) {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}


// --- Conversation list (single response, no pagination) ---

async function listConversations({ includeArchived = false } = {}) {
  const orgId = await getOrgId();
  console.log('[TK-DIAG] claude: listConversations — starting fetch');

  const url = `/api/organizations/${orgId}/chat_conversations`;
  const conversations = await fetchApi(url);

  if (!Array.isArray(conversations)) {
    throw new Error('Unexpected response format from chat_conversations endpoint');
  }

  console.log(`[TK-DIAG] claude: listConversations — got ${conversations.length} items`);

  // Archive filtering: if conversation objects expose is_archived, filter accordingly.
  // If the field is not present, treat all as active and log a diagnostic warning.
  // This is a known gap — Claude.ai's archive API surface is undetermined and
  // will be inspected during live testing. See PHASE_6_SCOPE.md.
  const hasArchiveField = conversations.length > 0 && 'is_archived' in conversations[0];
  if (!hasArchiveField && conversations.length > 0) {
    console.warn(
      '[TK-DIAG] claude: listConversations — no is_archived field detected; ' +
      'treating all as active'
    );
  }

  const filtered = hasArchiveField && !includeArchived
    ? conversations.filter((c) => !c.is_archived)
    : conversations;

  return filtered.map((item) => ({
    id: item.uuid,
    title: item.name || 'Untitled Conversation',
    url: `https://claude.ai/chat/${item.uuid}`,
    createdAt: safeISO(item.created_at),
    updatedAt: safeISO(item.updated_at),
  }));
}


// --- No-op for interface consistency ---
// API-based scrapers don't need to navigate to a conversation page.

// eslint-disable-next-line no-unused-vars
async function loadConversation(_id) {
  // No-op. Kept for interface parity with Gemini's DOM-scraping approach.
}


// --- Branch-aware message traversal ---
// chat_messages is a tree, not a flat list. Each message has uuid and
// parent_message_uuid. To extract the active branch: start at
// current_leaf_message_uuid, walk backwards via parent_message_uuid, reverse.
// Sibling branches (from message edits) are ignored.

function walkBranch(chatMessages, leafUuid) {
  const byUuid = new Map();
  for (const msg of chatMessages) {
    byUuid.set(msg.uuid, msg);
  }

  const branch = [];
  let current = leafUuid;
  while (current) {
    const msg = byUuid.get(current);
    if (!msg) break;
    branch.push(msg);
    current = msg.parent_message_uuid;
  }

  branch.reverse();
  return branch;
}


// --- Content block rendering ---

// Inline artifact tags (old format):
//   <antArtifact identifier="..." type="..." title="..." language="...">content</antArtifact>
// FRAGILE: Claude.ai may change artifact tag format at any time.
const ARTIFACT_TAG_RE = /<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>/g;

// Stray self-closing or orphaned artifact-related tags that appear in some responses.
const ARTIFACT_LINK_RE = /<\/?(?:antArtifact|ANTARTIFACTLINK)[^>]*\/?>/g;

function parseArtifactAttrs(attrStr) {
  const title = attrStr.match(/\btitle="([^"]*)"/)?.[1] || 'Untitled Artifact';
  const language = attrStr.match(/\blanguage="([^"]*)"/)?.[1] || '';
  return { title, language };
}

function renderContentBlocks(contentArray, includeThinking = true) {
  if (!Array.isArray(contentArray)) return '';

  const parts = [];

  for (const block of contentArray) {
    if (!block || !block.type) continue;

    if (block.type === 'text') {
      let text = block.text || '';

      // Extract inline artifacts (old format) before emitting prose.
      const artifactParts = [];
      text = text.replace(ARTIFACT_TAG_RE, (_match, attrs, content) => {
        const { title, language } = parseArtifactAttrs(attrs);
        artifactParts.push(
          `### Artifact: ${title}\n\`\`\`${language}\n${content.trim()}\n\`\`\``
        );
        return ''; // Remove from surrounding prose.
      });

      // Strip stray artifact link/closing tags.
      text = text.replace(ARTIFACT_LINK_RE, '').trim();

      if (text) parts.push(text);
      // Append extracted artifacts after the surrounding prose.
      parts.push(...artifactParts);
    }

    else if (block.type === 'thinking') {
      if (includeThinking) {
        const thinking = block.thinking || '';
        if (thinking.trim()) {
          parts.push(`### Thinking\n\`\`\`\`\n${thinking.trim()}\n\`\`\`\``);
        }
      }
    }

    else if (block.type === 'tool_use' || block.type === 'tool_result') {
      // Skip tool blocks in markdown output — preserved in raw JSON.
    }

    // New-format artifacts: some responses use a block with artifact metadata
    // as a structured sub-object rather than inline XML tags.
    // This covers any future API change that moves artifacts out of inline tags.
    else if (block.type === 'artifact' || block.artifact) {
      const meta = block.artifact || block;
      const title = meta.title || 'Untitled Artifact';
      const language = meta.language || '';
      const content = meta.content || meta.text || '';
      if (content.trim()) {
        parts.push(
          `### Artifact: ${title}\n\`\`\`${language}\n${content.trim()}\n\`\`\``
        );
      }
    }
  }

  return parts.join('\n\n');
}


// --- Fetch and parse a single conversation by ID ---

async function fetchConversationById(chatId, { includeThinking = true } = {}) {
  const orgId = await getOrgId();
  const url = `/api/organizations/${orgId}/chat_conversations/${chatId}` +
    '?tree=True&rendering_mode=messages&render_all_tools=true';
  const conv = await fetchApi(url);

  if (!conv.chat_messages || !conv.current_leaf_message_uuid) {
    throw new Error(`Conversation ${chatId} has no messages or leaf pointer`);
  }

  const branch = walkBranch(conv.chat_messages, conv.current_leaf_message_uuid);

  const messages = [];
  for (const msg of branch) {
    // Only include human and assistant messages; skip system/tool roles.
    if (msg.sender !== 'human' && msg.sender !== 'assistant') continue;

    const role = msg.sender === 'human' ? 'user' : 'assistant';
    const content = renderContentBlocks(msg.content, includeThinking);
    const timestamp = safeISO(msg.created_at);

    if (content.trim()) {
      messages.push({ role, content: content.trim(), timestamp });
    }
  }

  console.log(
    `[TK-DIAG] claude: fetchConversationById("${chatId}") — ` +
    `${messages.length} messages (branch of ${branch.length})`
  );

  return {
    site: 'claude',
    title: conv.name || 'Untitled Conversation',
    url: `https://claude.ai/chat/${chatId}`,
    exportedAt: new Date().toISOString(),
    messages,
    // Preserve the full API response for JSON export (scope doc:
    // "JSON output preserves the raw API response unmodified").
    _rawApiResponse: conv,
  };
}


// --- URL helpers ---

function getChatIdFromUrl() {
  // Matches: /chat/{uuid}
  const match = location.pathname.match(/\/chat\/([a-f0-9-]+)/i);
  return match ? match[1] : null;
}


// --- Message listener ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'PARSE_CURRENT') {
    return (async () => {
      try {
        const chatId = getChatIdFromUrl();
        if (!chatId) {
          return { ok: false, error: 'Not on a Claude.ai conversation page' };
        }

        // Read includeThinking preference from storage (default true).
        const stored = await browser.storage.local.get('includeThinking');
        const includeThinking = stored.includeThinking !== false;

        const data = await fetchConversationById(chatId, { includeThinking });
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'LIST_CONVERSATIONS') {
    return (async () => {
      try {
        const data = await listConversations({
          includeArchived: message.includeArchived,
        });
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    })();
  }

  if (message.type === 'FETCH_CONVERSATION') {
    return (async () => {
      try {
        const includeThinking = message.includeThinking !== false;
        const data = await fetchConversationById(message.chatId, { includeThinking });
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
  console.log(`[TK-DIAG] claude: CONTENT_READY firing — chatId="${chatId}", url="${location.href}"`);
  browser.runtime.sendMessage({
    type: 'CONTENT_READY',
    site: 'claude',
    chatId,
    url: location.href,
  });
} catch (_) {
  // Extension context invalidated.
}
