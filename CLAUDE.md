# Threadkeeper — Project Context

## What this is

Threadkeeper is a Firefox + Chrome browser extension that exports AI chat conversations from Gemini, ChatGPT, and Claude.ai to Markdown or JSON files on disk. Your data, your disk, your archive.

## Why it exists

The user has thousands of conversations across these three platforms and needs them archived locally as plain .md for ingestion into an Obsidian vault. Existing solutions are either expensive ($159 lifetime for chatgpt2notion), trust-questionable (random indie extensions with full web permissions), or single-purpose. This is a free, open, multi-platform alternative the user owns end-to-end.

## Who's working on it

- **Chris** (also "Anaximander Aletheia" online): project owner, decisions, testing. Novice programmer who works in vibe-coding mode — does not read or write code directly. Communicates via natural language and copies/pastes commands. Has built two browser extensions before, so understands the high-level shape.
- **Claude.ai (chat)**: architect and project manager. Decisions, design, debugging, drafts prompts for Claude Code. Lives in Chris's browser.
- **Claude Code (you)**: executor. Writes and edits the actual files in this repo. Runs commands. Tests against live sites when needed. Commits to Git with descriptive messages.

The rule: decisions happen in chat with Claude.ai; execution happens here. If you (Claude Code) want to push back on a decision, surface it back to chat rather than relitigating it in code.

## Architectural decisions already made

- **Manifest V3**, Firefox-first. Background uses `scripts` array, not `service_worker`. Chrome compatibility will be handled by a build-step manifest swap in Phase 7.
- **Plain JavaScript**, no TypeScript, no build step
- **Three target sites in v1**: Gemini, ChatGPT, Claude.ai
- **Output formats**: Markdown (primary) and JSON (raw backup); user picks per export
- **UX surface**: single-chat export, bulk export, and selective export (checklist)
- **Permissions**: minimum viable. `downloads`, `storage`, `scripting`, `activeTab`, plus `host_permissions` scoped exactly to the three target domains. **Never broaden host_permissions to all sites.**
- **Privacy posture**: zero network calls outside the target AI sites. No analytics, no telemetry, no remote logging. All processing happens in the browser.

## Code organization
ai-chat-archiver/
├── manifest.json                       extension config
├── CLAUDE.md                           this file
├── README.md                           user-facing
├── popup/                              click-icon UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content-scripts/                    per-site DOM scrapers
│   ├── shared.js                       common helpers, message protocol
│   ├── gemini.js
│   ├── chatgpt.js
│   └── claude.js
├── background/
│   └── background.js                   orchestration, downloads, message routing
├── lib/                                pure-function utilities
│   ├── markdown.js                     normalized data → .md string
│   ├── json.js                         normalized data → .json string
│   └── filename.js                     safe filename generation
└── icons/                              placeholder for now

## The site abstraction

Each content script must export (via window or messaging) three functions:

- `listConversations()` → `Promise<Array<{id, title, url, createdAt?}>>`
- `loadConversation(id)` → `Promise<void>` (navigates browser to that conversation, waits for it to render)
- `parseMessages()` → `Promise<Array<{role: 'user'|'assistant', content: string, timestamp?: string}>>`

The normalized data structure these produce is what the markdown/json formatters consume. **Adding a new site = implementing these three functions.** Do not leak site-specific logic into the formatters or the background script.

## Build phases

1. ✅ Scaffold + manifest + skeleton files
2. ✅ Popup UI shell (HTML/CSS/JS, no scraping yet)
3. ✅ Gemini scraper — single chat export to MD/JSON
4. ✅ Gemini scraper — bulk + selective
5. ⬜ ChatGPT scraper (single → bulk)
6. ⬜ Claude scraper (single → bulk)
7. ⬜ Polish, icons, README expansion, store submission prep

## Coding conventions

- ES6+ JavaScript, async/await over .then chains
- No external dependencies in v1 (keep it auditable; no npm install dance)
- One purpose per file; if a file is doing two things, split it
- Comments explain *why*, not *what* (the code tells you what)
- Filenames in this repo: kebab-case (e.g. `content-scripts/gemini.js`)
- Generated filenames for exports: `YYYY-MM-DD-conversation-title.md` (kebab-case title, ASCII-safe)

## Things to be careful about

- AI site DOMs change frequently. When writing selectors, prefer stable attributes (data-testid, role, aria-label) over class names. Add a comment noting which selectors are likely to break.
- Chrome MV3 service workers go idle. State that must persist across user actions belongs in chrome.storage, not in service worker globals.
- Content scripts cannot call chrome.downloads directly — they must postMessage to the background.
- Rate-limit bulk export operations. Some AI sites rate-limit aggressive navigation. Pause ~500ms between conversations in bulk mode by default; make it configurable.
- The user has shipped extensions before, so don't over-explain extension fundamentals — but do explain non-obvious choices.

## Out of scope for v1

- Real-time sync (this is an export tool, not a sync tool)
- Editing or modifying conversations on the AI sites
- Cloud storage targets (Notion, Drive, Dropbox) — local files only
- Anything that requires the user to enter API keys
