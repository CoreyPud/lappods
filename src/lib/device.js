'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { scan } = require('./scanner');
const { fileKey } = require('./names');

// Reads and manages audio already on the destination device. The device is
// just a mounted folder, so enumeration reuses the same folder scanner the
// Files tab uses; removal and key-indexing are device-specific.

// True when `child` resolves to a path strictly inside `parent`. Used to refuse
// deleting anything outside the device mount.
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// True when a base name is macOS filesystem cruft: AppleDouble sidecars (`._*`)
// or Finder's `.DS_Store`. These accumulate from manual Finder drags onto the
// drive (our own exporter copies via Node streams and never makes them), and
// some players try to read `._*` files as audio and choke.
function isMacJunk(name) {
  return name === '.DS_Store' || name.startsWith('._');
}

// Recursively deletes macOS junk files (`._*`, `.DS_Store`) from the mount,
// leaving real audio untouched. Refuses any path that does not resolve inside
// the mount, reusing the same guard as removeFromDevice. Safe to call on every
// device load and after each export.
async function cleanDeviceJunk(mountPoint) {
  const removed = [];
  const errors = [];
  if (!mountPoint) return { removed, errors };

  let mountReal;
  try {
    mountReal = await fsp.realpath(mountPoint);
  } catch {
    return { removed, errors: [{ path: mountPoint, message: 'device not found' }] };
  }

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: dir, message: err.message });
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (isMacJunk(entry.name)) {
        if (!isInside(mountReal, full)) continue;
        try {
          await fsp.unlink(full);
          removed.push(full);
        } catch (err) {
          errors.push({ path: full, message: err.message });
        }
      }
    }
  }

  await walk(mountReal);
  return { removed, errors };
}

// Lists the device's audio, grouped by folder, with embedded tags — same shape
// the Files tab renders. Sweeps macOS junk first so a stray `._foo.mp3` never
// shows up as a phantom track.
async function listDevice(mountPoint) {
  if (!mountPoint) return { groups: [], fileCount: 0, roots: [] };
  await cleanDeviceJunk(mountPoint);
  return scan({ roots: [mountPoint] });
}

// Returns the set of duplicate-match keys for everything currently on the
// device, as a de-duplicated array. The renderer flags a candidate as
// on-device when the candidate's titleKey is in this set.
async function deviceKeys(mountPoint) {
  const { groups } = await listDevice(mountPoint);
  const keys = new Set();
  for (const group of groups) {
    for (const item of group.items) {
      const key = fileKey(item.fileName);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

// One canonical playlist per device, regenerated from current contents so it
// can never go stale after a removal.
const CANONICAL_PLAYLIST = 'LapPods.m3u';

// Rewrites the device's canonical .m3u to reflect exactly what's on it now,
// overwriting any prior copy. With `onlyIfExists`, it refreshes an existing
// playlist but won't create one from nothing (so removals stay in sync without
// forcing a playlist on users who don't keep one).
async function writeDevicePlaylist(mountPoint, { onlyIfExists = false } = {}) {
  if (!mountPoint) return null;
  const playlistPath = path.join(mountPoint, CANONICAL_PLAYLIST);
  if (onlyIfExists && !fs.existsSync(playlistPath)) return null;

  const { groups } = await listDevice(mountPoint);
  const rels = [];
  for (const group of groups) {
    for (const item of group.items) {
      rels.push(path.relative(mountPoint, item.srcPath).split(path.sep).join('/'));
    }
  }

  if (rels.length === 0) {
    try {
      await fsp.unlink(playlistPath);
    } catch {}
    return null;
  }

  rels.sort((a, b) => a.localeCompare(b));
  const lines = ['#EXTM3U', ...rels];
  await fsp.writeFile(playlistPath, lines.join('\r\n') + '\r\n', 'utf8');
  return playlistPath;
}

// Permanently deletes the given files from the device, then prunes any folders
// left empty. Refuses any path that does not resolve inside the mount.
async function removeFromDevice(mountPoint, filePaths) {
  const removed = [];
  const errors = [];

  let mountReal;
  try {
    mountReal = await fsp.realpath(mountPoint);
  } catch {
    return { removed, errors: [{ path: mountPoint, message: 'device not found' }] };
  }

  const dirsToCheck = new Set();

  for (const filePath of filePaths || []) {
    try {
      const real = await fsp.realpath(filePath);
      if (!isInside(mountReal, real)) {
        errors.push({ path: filePath, message: 'refused: outside device' });
        continue;
      }
      await fsp.unlink(real);
      removed.push(filePath);
      dirsToCheck.add(path.dirname(real));
    } catch (err) {
      errors.push({ path: filePath, message: err.message });
    }
  }

  // Prune emptied folders, walking up toward (but never removing) the mount.
  for (const startDir of dirsToCheck) {
    let dir = startDir;
    while (isInside(mountReal, dir)) {
      let entries;
      try {
        entries = await fsp.readdir(dir);
      } catch {
        break;
      }
      if (entries.length > 0) break;
      try {
        await fsp.rmdir(dir);
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  // Keep an existing canonical playlist in sync with what's left.
  if (removed.length > 0) {
    try {
      await writeDevicePlaylist(mountReal, { onlyIfExists: true });
    } catch {}
  }

  return { removed, errors };
}

module.exports = {
  listDevice,
  deviceKeys,
  removeFromDevice,
  writeDevicePlaylist,
  cleanDeviceJunk,
  isInside,
  CANONICAL_PLAYLIST,
};
