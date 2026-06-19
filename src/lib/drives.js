'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const VOLUMES = '/Volumes';

// Names the Shokz family of drives tend to mount as.
const SHOKZ_HINTS = ['swim pro', 'openswim', 'shokz', 'xtrainerz', 'aftershokz'];

function looksLikeShokz(name) {
  const n = name.toLowerCase();
  return SHOKZ_HINTS.some((h) => n.includes(h));
}

async function diskInfo(mountPoint) {
  try {
    const { stdout } = await execFileAsync('diskutil', ['info', mountPoint]);
    const info = {};
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return info;
  } catch {
    return {};
  }
}

// Lists mounted volumes that are sensible export targets (removable media
// and external drives), plus flags the likely Shokz device.
async function listDrives() {
  let names;
  try {
    names = fs.readdirSync(VOLUMES);
  } catch {
    return [];
  }

  const drives = [];
  for (const name of names) {
    const mountPoint = path.join(VOLUMES, name);
    let stat;
    try {
      stat = fs.statSync(mountPoint);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const info = await diskInfo(mountPoint);
    const removable =
      info['Removable Media'] === 'Removable' ||
      info['Removable Media'] === 'Yes';
    const internal = info['Device Location'] === 'Internal';
    const isShokz = looksLikeShokz(name);

    // Skip the internal boot disk; keep removable/external volumes.
    if (internal && !removable && !isShokz) continue;

    let freeBytes = null;
    const m = (info['Volume Free Space'] || '').match(/\((\d+) Bytes\)/);
    if (m) freeBytes = Number(m[1]);

    drives.push({
      name,
      mountPoint,
      fileSystem: info['File System Personality'] || null,
      removable,
      isShokz,
      freeBytes,
    });
  }

  // Shokz first, then by name.
  drives.sort((a, b) => {
    if (a.isShokz !== b.isShokz) return a.isShokz ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return drives;
}

module.exports = { listDrives };
