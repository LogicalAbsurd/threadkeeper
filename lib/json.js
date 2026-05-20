// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

// Converts normalized conversation data to pretty-printed JSON.
// Loaded by background.js via importScripts (Chrome) or background.scripts (Firefox).
// eslint-disable-next-line no-unused-vars
function toJSON(data) {
  return JSON.stringify(data, null, 2);
}

// Combines multiple conversations into a single JSON document.
// eslint-disable-next-line no-unused-vars
function toCombinedJSON(conversations) {
  const payload = {
    type: 'conversation-collection',
    exportedAt: new Date().toISOString(),
    conversationCount: conversations.length,
    conversations,
  };
  return JSON.stringify(payload, null, 2);
}
