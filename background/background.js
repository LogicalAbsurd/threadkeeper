// Cross-browser background script.
//
// Chrome MV3: runs as a service worker (background.service_worker).
//   - No DOM access, no global state that survives idle timeout (~30s).
//   - All persistent state must go through chrome.storage.
//   - Event listeners must be registered synchronously at the top level
//     on every startup — they cannot be added inside async callbacks.
//
// Firefox MV3: runs as an event page (background.scripts).
//   - Similar idle-suspend lifecycle, but the page has a DOM (document,
//     window) and can use XMLHttpRequest in addition to fetch.
//   - Same rule: register listeners at top level, persist state in storage.
//
// Practical upshot: write this file as if it's a service worker (the
// stricter model). Avoid global mutable state, register all listeners
// synchronously, and use browser.storage for anything that must survive
// a restart. That way it works in both browsers.

'use strict';

console.log('Chat Archiver background loaded');
