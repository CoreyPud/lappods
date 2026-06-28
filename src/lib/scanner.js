'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// Formats the OpenSwim Pro (and most players) can handle.
const AUDIO_EXTS = new Set([
  '.mp3', '.m4a', '.aac', '.wav', '.flac', '.wma',
  '.ogg', '.oga', '.aiff', '.aif', '.m4b',
]);
// Protected / unplayable on the device — surfaced but not exportable.
const PROTECTED_EXTS = new Set(['.m4p']);

const DEFAULT_ROOTS = {
  Downloads: path.join(os.homedir(), 'Downloads'),
  Music: path.join(os.homedir(), 'Music'),
  Desktop: path.join(os.homedir(), 'Desktop'),
  Documents: path.join(os.homedir(), 'Documents'),
};

// Directory names we never want to descend into.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.Trash', 'Library',
]);
// Bundle/package suffixes (macOS "files that are really folders").
const SKIP_SUFFIXES = ['.photoslibrary', '.musiclibrary', '.tvlibrary', '.app', '.bundle'];

const MAX_FILES = 8000;
const MAX_DEPTH = 9;

function defaultRoots(keys = ['Downloads', 'Music', 'Desktop']) {
  return keys
    .map((k) => DEFAULT_ROOTS[k] || k)
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

function shouldSkipDir(name) {
  if (name.startsWith('.')) return true;
  if (SKIP_DIRS.has(name)) return true;
  return SKIP_SUFFIXES.some((s) => name.toLowerCase().endsWith(s));
}

// Walk a set of roots, collecting audio files (path + stat). Reports progress
// via onProgress({ found }) periodically.
async function walk(roots, onProgress) {
  const files = [];
  let lastReport = 0;

  async function recurse(dir, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await recurse(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const isAudio = AUDIO_EXTS.has(ext);
      const isProtected = PROTECTED_EXTS.has(ext);
      if (!isAudio && !isProtected) continue;
      let size = null, mtime = null;
      try {
        const st = await fsp.stat(full);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      // `reason` explains why a file can't be exported (null = exportable).
      // ALAC is detected later from the codec; DRM is known from the extension.
      const reason = isProtected ? 'drm' : null;
      files.push({ path: full, ext, size, mtime, exportable: isAudio, reason });
      if (files.length - lastReport >= 25) {
        lastReport = files.length;
        onProgress?.({ found: files.length });
      }
    }
  }

  for (const root of roots) await recurse(root, 0);
  onProgress?.({ found: files.length });
  return files;
}

// Reads embedded tags for a batch of files with a bounded concurrency pool.
async function readTags(files, onProgress) {
  const mm = await import('music-metadata');
  let done = 0;
  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const i = cursor++;
      const f = files[i];
      try {
        const meta = await mm.parseFile(f.path, {
          duration: true,
          skipCovers: true,
        });
        const c = meta.common || {};
        f.title = c.title || null;
        f.artist = c.artist || (c.artists && c.artists[0]) || null;
        f.album = c.album || null;
        f.trackNo = c.track && c.track.no ? c.track.no : null;
        f.duration = meta.format ? meta.format.duration || null : null;
        // The OpenSwim Pro's "M4A" support is AAC-in-m4a only. Apple Lossless
        // (ALAC) files share the .m4a extension but trigger a "data error" that
        // blocks the device entirely, so flag them as non-exportable here —
        // the extension alone can't tell ALAC and AAC apart.
        const codec = (meta.format && meta.format.codec || '').toLowerCase();
        if (codec === 'alac') {
          f.exportable = false;
          f.reason = 'alac';
        }
      } catch {
        // Unreadable/odd file — fall back to filename-only.
      }
      done++;
      if (done % 25 === 0) onProgress?.({ tagged: done, total: files.length });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker)
  );
  onProgress?.({ tagged: files.length, total: files.length });
}

// Groups files by their containing folder, newest-modified folders first.
function groupByFolder(files) {
  const byDir = new Map();
  for (const f of files) {
    const dir = path.dirname(f.path);
    if (!byDir.has(dir)) {
      byDir.set(dir, { dir, name: path.basename(dir) || dir, items: [], latest: 0 });
    }
    const g = byDir.get(dir);
    g.items.push({
      id: 'file:' + f.path,
      srcPath: f.path,
      fileName: path.basename(f.path),
      title: f.title || null,
      artist: f.artist || null,
      album: f.album || null,
      trackNo: f.trackNo || null,
      duration: f.duration || null,
      size: f.size,
      mtime: f.mtime,
      exportable: f.exportable,
      reason: f.reason || null,
    });
    if (f.mtime > g.latest) g.latest = f.mtime;
  }

  const groups = Array.from(byDir.values());
  for (const g of groups) {
    g.items.sort((a, b) => {
      if (a.trackNo && b.trackNo) return a.trackNo - b.trackNo;
      return (a.title || a.fileName).localeCompare(b.title || b.fileName);
    });
    g.exportableCount = g.items.filter((i) => i.exportable).length;
  }
  groups.sort((a, b) => b.latest - a.latest);
  return groups;
}

// Full scan pipeline: walk → read tags → group. `roots` may be a list of
// preset keys (Downloads/Music/Desktop/Documents) and/or absolute paths.
async function scan(options = {}, onProgress) {
  const roots =
    options.roots && options.roots.length
      ? defaultRoots(options.roots)
      : defaultRoots();

  onProgress?.({ phase: 'walking', found: 0 });
  const files = await walk(roots, (p) =>
    onProgress?.({ phase: 'walking', ...p })
  );

  onProgress?.({ phase: 'tagging', tagged: 0, total: files.length });
  await readTags(files, (p) => onProgress?.({ phase: 'tagging', ...p }));

  const groups = groupByFolder(files);
  onProgress?.({ phase: 'done', total: files.length, groups: groups.length });
  return { groups, fileCount: files.length, roots };
}

module.exports = { scan, defaultRoots, DEFAULT_ROOTS };
