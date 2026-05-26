# Phase 6 — Claude.ai Scraper

## Status

Not started. Phase 5 (ChatGPT) verified in production 2026-05-26.

## Project context shift

Earlier phases were built as a personal utility — "tool to export my chats while waiting for the official archive." As of 2026-05-26, Threadkeeper's purpose has expanded:

- Portfolio piece: demonstrates multi-platform browser extension craft, MV3, clean architecture, careful API integration
- Potential lead magnet for adjacent paid work
- Free, open-source, AGPL-3.0, no paywall on the tool itself

This changes how Phase 6 is built. We do not skip steps. We do not cut corners. Feature completeness against existing competitors matters; "good enough for my own use" is no longer the bar.

## Competitive landscape

Existing Claude.ai exporters as of 2026-05:

- agoramachina/claude-exporter — 15 stars, on Chrome Web Store and Firefox AMO, MIT licensed. Branch-aware, artifact extraction, organization auto-detect, model inference. Forked from socketteer/Claude-Conversation-Exporter.
- pranaysuyash — paid Gumroad extension, HTML output only

Threadkeeper's differentiator is multi-platform (Gemini + ChatGPT + Claude.ai in one tool). Phase 6 quality must be at least equivalent to agoramachina/claude-exporter for the Claude.ai-specific feature set, or the multi-platform argument is undermined.

## Out-of-scope corner-cuts that were considered and rejected

The following shortcuts were briefly considered during planning and explicitly rejected:

- "Skip branch traversal and just iterate chat_messages in order" — would silently produce wrong output for any conversation where the user edited a message. Not acceptable.
- "Skip thinking blocks" — they're a Claude.ai-specific feature with real archival value and competitive tools preserve them.
- "Skip artifacts entirely; just leave inline tags in text" — artifacts are first-class content in Claude.ai. Stripping them or leaving raw tags is wrong-shaped.
- "Require user to manually paste organization UUID" — competitive tools auto-detect; manual config is a UX regression.
- "Skip archive support since Claude.ai's archive UX is less prominent than ChatGPT's" — symmetry with Phase 5 matters. Users expect feature parity across sites.

## API contract

Source: discovery via agoramachina/claude-exporter (MIT). Credit in ACKNOWLEDGMENTS.md and README.

Auth: cookie-based via `credentials: 'include'` and `Accept: application/json`. No token endpoint needed (unlike ChatGPT).

### Endpoints

- `GET /api/organizations` — returns array of orgs. Filter for one whose `capabilities` array includes `"chat"`. Use its `uuid` as the org ID. Falls back to first org if no chat-capable org found.
- `GET /api/organizations/{orgId}/chat_conversations` — returns array of conversation summaries. No pagination — single response. Fields per item: `uuid`, `name`, `created_at`, `updated_at`, `model`, possibly `is_starred`, possibly archive flags (TBD via inspection during implementation).
- `GET /api/organizations/{orgId}/chat_conversations/{convUuid}?tree=True&rendering_mode=messages&render_all_tools=true` — returns full conversation object with `chat_messages` array and `current_leaf_message_uuid`.

### Message structure

`chat_messages` is a tree, not a flat list. Each message has `uuid`, `parent_message_uuid`, `sender` ("human" or "assistant"), `content` array, `created_at`. To extract the active branch: start at `current_leaf_message_uuid`, walk backwards via `parent_message_uuid`, reverse the collected list.

### Content block types observed

- `text` — standard prose. Field: `content[i].text`.
- `thinking` — extended thinking output. Field: `content[i].thinking`.
- `tool_use` — model invoking a tool. Skip for v1 markdown output but preserve in JSON output.
- Artifacts appear in two formats: old (inline `` tags within text) and new (separate content blocks). Both must be handled.

## Acceptance criteria

Phase 6 is complete when all of the following are true:

### Functional

- Single conversation export works on any non-empty conversation in the user's account
- Bulk export works on the full conversation list including archived (if archive flag exposed by API)
- Markdown output preserves: user/assistant alternation, code blocks with language tags, thinking blocks rendered with quadruple-backtick code fences and a `### Thinking` header, artifacts rendered with `### Artifact: {title}` headers and proper code fences
- JSON output preserves the raw API response unmodified
- Branch handling: only the active branch (per `current_leaf_message_uuid`) is rendered; sibling branches are not duplicated into output
- Organization ID auto-detected on first run; cached in `chrome.storage.local`; refetched if cache stale
- Conversation list shows correct titles (fallback to "Untitled Conversation" if `name` is empty)
- Filename pattern matches other sites: `YYYY-MM-DD-kebab-title.md`

### Non-functional

- Rate-limit handling: 429 responses trigger exponential backoff per Retry-After header
- Configurable inter-conversation delay (default 500ms, same as Phase 5)
- Diagnostic logging consistent with Phase 5 (`[TK-DIAG]` prefix, paginate/fetch/done lifecycle)
- Error handling: network failures, auth expiry, malformed responses all produce user-visible errors without crashing the extension
- No DOM scraping. API only. Same architectural posture as Phase 5.

### Documentation

- ACKNOWLEDGMENTS.md updated with agoramachina/claude-exporter and socketteer/Claude-Conversation-Exporter credits, both MIT
- README.md updated: Claude.ai listed as supported, brief usage note
- CLAUDE.md updated: Phase 6 marked complete in the build phases list

### Testing

- Tested against at least one short conversation, one long conversation (200+ messages), one with code blocks, one with thinking blocks, one with artifacts, and one archived conversation
- Verified output by opening .md files in Obsidian (the target ingestion environment) and confirming render is clean

## Implementation order

1. Read agoramachina/claude-exporter source thoroughly. Understand their branch-walk, content-block parsing, artifact extraction, and error handling. Do not paste their code; understand it.
2. Implement `content-scripts/claude.js` with the three required functions: `listConversations()`, `loadConversation(id)` (no-op since API approach), `parseMessages()`.
3. Wire org-ID auto-detection into the initialization path.
4. Wire popup detection: badge shows "Claude" when on claude.ai.
5. Wire `host_permissions` are already set in manifest; verify content_scripts match pattern is correct.
6. Implement archive support if API surfaces archived conversations (inspect during implementation).
7. Integration testing per acceptance criteria above.
8. Documentation updates.
9. Commit in logical chunks (scraper, archive support if applicable, docs) with conventional commit messages.

## Decisions deferred to Phase 7

These were considered for Phase 6 but pushed to Phase 7 because they're polish that applies across all sites, not Claude-specific work:

- Artifact-as-separate-file export option (per agoramachina's ZIP approach)
- Image/attachment extraction
- Project-scoped conversation listing
- Multi-branch export (e.g., export all branches, not just current)

## Anti-scope (never)

These will never be in Threadkeeper:

- Cloud storage targets
- API key requirements
- Telemetry of any kind
- Modification of conversations on the source site
