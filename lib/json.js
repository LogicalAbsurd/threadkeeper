// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Chris (LogicalAbsurd)

'use strict';

// Converts normalized conversation data to pretty-printed JSON.
// Loaded by background.js via importScripts (Chrome) or background.scripts (Firefox).
// eslint-disable-next-line no-unused-vars
function toJSON(data) {
  return JSON.stringify(data, null, 2);
}
