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

// Lists the device's audio, grouped by folder, with embedded tags — same shape
// the Files tab renders.
async function listDevice(mountPoint) {
  if (!mountPoint) return { groups: [], fileCount: 0, roots: [] };
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

  return { removed, errors };
}

module.exports = { listDevice, deviceKeys, removeFromDevice, isInside };
