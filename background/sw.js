// Chrome MV3 service worker entry point.
// Loads the lib files then the main background script.
importScripts('../lib/filename.js', '../lib/markdown.js', '../lib/json.js', './background.js');
