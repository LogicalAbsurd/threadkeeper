# Threadkeeper

Export your AI chat conversations to Markdown or JSON. Your data, your disk, your archive.

A Firefox and Chrome (Manifest V3) browser extension that exports conversations from ChatGPT, Claude.ai, and Google Gemini to local Markdown or JSON files. No accounts, no servers, no API keys — everything runs in the browser against the sites you're already logged into.

<p align="center">
  <img src="screenshots/popup-claude.png" alt="Threadkeeper popup on Claude.ai" width="320">
</p>

## Status

Threadkeeper is in a working, late-development stage supporting exports from all three platforms. Planned: UX design, further documentation, a future-features brainstorm, Mozilla Add-ons / Chrome Web Store submission, and possible monetization.

## Features

- **Three platforms:** ChatGPT, Claude.ai, Google Gemini
- **Export modes:** single conversation, bulk (all), or selective (pick from a searchable checklist)
- **Output formats:** Markdown (primary) and JSON (raw backup), individually or combined
- **Preserves** code blocks, conversation structure, and message ordering
- **Claude.ai extras:** optional extended-thinking blocks; artifacts rendered inline
- **Local-only:** no network calls beyond the AI sites themselves; no analytics, no telemetry

<p align="center">
  <img src="screenshots/popup-gemini.png" alt="Threadkeeper on Gemini" width="260">
  <img src="screenshots/popup-chatgpt.png" alt="Threadkeeper on ChatGPT, settings expanded" width="260">
  <img src="screenshots/popup-claude.png" alt="Threadkeeper on Claude.ai" width="260">
</p>

## Installation

Threadkeeper is not yet on extension stores. For now, install it as a temporary add-on:

1. Clone or download this repo.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the `manifest.json` file from the repo root.

Permanent install via Mozilla Add-ons and the Chrome Web Store is planned.

## Usage

Click the Threadkeeper toolbar icon while on a supported site. For single-chat export, pick your format and click Export. For bulk or selective export, choose your mode from the popup — an export page opens with a searchable conversation list, format and output options, and progress tracking.

<p align="center">
  <img src="screenshots/export-select.png" alt="Selective export with searchable conversation list" width="720">
</p>

Exports run with progress tracking and a per-conversation log. You can pause, cancel, or kick off a new export from the completion screen.

<p align="center">
  <img src="screenshots/export-progress.png" alt="Export in progress and complete" width="720">
</p>

## How it works

Each supported site implements a common three-function interface: list conversations, load a conversation, and parse its messages. Adding a platform means implementing that triad without touching the formatters or background script. ChatGPT and Claude.ai use their internal JSON APIs via cookie-based auth — no DOM scraping required. Gemini uses DOM extraction with a three-technique lazy-load strategy to capture long conversations. A background script owns downloads and orchestration; content scripts never navigate or download directly. Normalized message data flows into pure-function Markdown and JSON formatters that are completely site-agnostic.

## Privacy

All processing happens locally in your browser. Host permissions are scoped to exactly the three target domains (`chatgpt.com`, `claude.ai`, `gemini.google.com`) and nothing else. Threadkeeper makes no network requests of its own — it talks only to the AI sites you're already using, to read your conversations. Exported files are saved directly to your computer's Downloads folder. Nothing is ever transmitted to any third party, and there are no analytics or telemetry of any kind.

## Known limitations

### Conversations from deleted Gems
If you previously created a Gem (custom Gemini persona) and later deleted it, conversations you had with that Gem become "orphaned" — they remain in Gemini's search but lose their title-rendering context. Threadkeeper will export their content correctly, but uses the first user message as the filename instead of a proper title.

## Acknowledgments

ChatGPT export support adapts API and authentication patterns from [chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) by Pionxzh (MIT). Claude.ai export support adapts patterns from [claude-exporter](https://github.com/agoramachina/claude-exporter) by agoramachina and [Claude-Conversation-Exporter](https://github.com/socketteer/Claude-Conversation-Exporter) by socketteer (both MIT). See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for details.

## License

Licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE).
