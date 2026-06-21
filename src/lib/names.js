'use strict';

// Filename normalization shared by the exporter (when writing files to a
// device) and by duplicate detection (when matching candidates against what's
// already on the device). Keeping both sides on the same `sanitize` is what
// makes "would the exporter's output already exist?" a reliable check.

// Strip characters that FAT32 (and most media players) choke on, collapse
// whitespace, and keep names to a safe length.
function sanitize(name, fallback = 'untitled') {
  if (!name) return fallback;
  let out = name
    .replace(/[\/\\:*?"<>|]/g, ' ') // illegal on FAT32
    .replace(/[\x00-\x1f]/g, ' ') // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // FAT32 dislikes trailing dot/space
  if (!out) out = fallback;
  if (out.length > 120) out = out.slice(0, 120).trim();
  return out;
}

// Shared key: drop a leading "NN - " track-number prefix, sanitize the same way
// the exporter does, and lowercase so matching is case-insensitive. Returns ''
// for empty/garbage input so it never matches by accident.
function normalizeBase(base) {
  const noNumber = String(base || '').replace(/^\d+\s*-\s*/, '');
  return sanitize(noNumber, '').toLowerCase();
}

// Match key for a file already on the device. Strips the real audio extension
// the exporter appended (`.mp3`, `.m4a`, …) but nothing else, and ignores any
// containing folder by using the basename only.
function fileKey(filename) {
  const base = String(filename || '').split(/[/\\]/).pop().replace(/\.[^.]+$/, '');
  return normalizeBase(base);
}

// Match key for a candidate's would-be export name. No extension semantics — a
// title like "Ep 4.5" must keep its ".5", so this never strips a trailing dot
// segment the way fileKey does.
function titleKey(title) {
  return normalizeBase(title);
}

module.exports = { sanitize, fileKey, titleKey };
