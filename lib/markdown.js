// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

// Converts normalized conversation data to an Obsidian-friendly Markdown string.
// Loaded by background.js via importScripts (Chrome) or background.scripts (Firefox).

const SITE_LABELS = {
  gemini: 'Gemini',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
};

// eslint-disable-next-line no-unused-vars
function toMarkdown(data) {
  const assistantLabel = SITE_LABELS[data.site] || data.site;

  // YAML frontmatter — title is quoted to handle colons and special chars.
  const escapedTitle = data.title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    '---',
    `source: ${data.url}`,
    `site: ${data.site}`,
    `title: "${escapedTitle}"`,
    `exported_at: ${data.exportedAt}`,
    `message_count: ${data.messages.length}`,
    '---',
    '',
    `# ${data.title}`,
    '',
  ];

  for (const msg of data.messages) {
    const heading = msg.role === 'user' ? 'You' : assistantLabel;
    lines.push(`## ${heading}`, '', msg.content.trim(), '');
  }

  return lines.join('\n');
}

// Combines multiple conversations into a single Markdown document.
// eslint-disable-next-line no-unused-vars
function toCombinedMarkdown(conversations) {
  const now = new Date().toISOString();
  const lines = [
    '---',
    'type: conversation-collection',
    `exported_at: ${now}`,
    `conversation_count: ${conversations.length}`,
    '---',
    '',
  ];

  for (let i = 0; i < conversations.length; i++) {
    // Strip the per-conversation YAML frontmatter, keep the # Title and content.
    const body = toMarkdown(conversations[i]);
    const afterFrontmatter = body.replace(/^---[\s\S]*?---\n+/, '');
    lines.push(afterFrontmatter);
    if (i < conversations.length - 1) {
      lines.push('\n---\n');
    }
  }

  return lines.join('\n');
}
