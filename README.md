# Threadkeeper

Export your AI chat conversations to Markdown or JSON. Your data, your disk, your archive.

A Firefox & Chrome extension that exports conversations from Google Gemini, ChatGPT, and Claude.ai to local files.

## Status

Early development. Not yet packaged.

## Known Limitations

### Conversations from deleted Gems
If you previously created a Gem (custom Gemini persona) and later deleted it, conversations you had with that Gem become "orphaned" — they remain in Gemini's search but lose their title-rendering context. Threadkeeper will export their content correctly, but uses the first user message as the filename instead of a proper title.

## Acknowledgments

ChatGPT export support uses API endpoint and authentication patterns adapted from [chatgpt-exporter](https://github.com/pionxzh/chatgpt-exporter) by Pionxzh (MIT license). See [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for details.

## License

Licensed under AGPL-3.0-or-later. See [LICENSE](LICENSE).
