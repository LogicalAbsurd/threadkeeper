'use strict';

// Generates a filesystem-safe filename: YYYY-MM-DD-kebab-case-title.ext
// Loaded by background.js via importScripts (Chrome) or background.scripts (Firefox).
// eslint-disable-next-line no-unused-vars
function safeFilename(title, date, ext) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  let slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip combining marks (accents)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // non-alphanumeric → hyphens
    .replace(/-{2,}/g, '-')          // collapse consecutive hyphens
    .replace(/^-|-$/g, '');          // trim leading/trailing hyphens

  if (!slug) slug = 'untitled';
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-$/, '');

  return `${dateStr}-${slug}.${ext}`;
}
