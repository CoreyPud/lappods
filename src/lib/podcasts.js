'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Apple Podcasts group container on macOS.
const CONTAINER = path.join(
  os.homedir(),
  'Library/Group Containers/243LU875E5.groups.com.apple.podcasts'
);
const DB_DIR = path.join(CONTAINER, 'Documents');
const DB_NAME = 'MTLibrary.sqlite';

// Core Data stores dates as seconds since 2001-01-01 UTC.
const COREDATA_EPOCH_OFFSET = 978307200;

function coreDataToISO(seconds) {
  if (seconds == null) return null;
  return new Date((seconds + COREDATA_EPOCH_OFFSET) * 1000).toISOString();
}

function libraryExists() {
  return fs.existsSync(path.join(DB_DIR, DB_NAME));
}

// Copy the live DB (plus -wal/-shm) to a temp dir so we never lock or
// mutate the database Apple Podcasts is actively using.
function snapshotDatabase() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lappods-'));
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(DB_DIR, DB_NAME + suffix);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tmpDir, DB_NAME + suffix));
    }
  }
  return { tmpDir, dbPath: path.join(tmpDir, DB_NAME) };
}

async function queryJSON(dbPath, sql) {
  // -readonly + JSON output. macOS ships sqlite3 with .mode json support.
  const { stdout } = await execFileAsync(
    'sqlite3',
    ['-readonly', '-json', dbPath, sql],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

function artworkURL(template, size = 300) {
  if (!template) return null;
  return template
    .replace('{w}', String(size))
    .replace('{h}', String(size))
    .replace('{f}', 'jpg')
    .replace('{c}', 'bb');
}

// Returns the full library: shows, each with their episodes.
async function readLibrary() {
  if (!libraryExists()) {
    throw new Error(
      'Apple Podcasts library not found. Open the Podcasts app and download at least one episode first.'
    );
  }

  const { tmpDir, dbPath } = snapshotDatabase();
  try {
    const shows = await queryJSON(
      dbPath,
      `SELECT Z_PK AS pk, ZTITLE AS title, ZAUTHOR AS author,
              ZARTWORKTEMPLATEURL AS artwork
       FROM ZMTPODCAST
       WHERE ZTITLE IS NOT NULL
       ORDER BY ZTITLE COLLATE NOCASE;`
    );

    const episodes = await queryJSON(
      dbPath,
      `SELECT Z_PK AS pk, ZPODCAST AS showPk, ZTITLE AS title,
              ZASSETURL AS assetURL, ZDURATION AS duration,
              ZPUBDATE AS pubDate
       FROM ZMTEPISODE
       WHERE ZTITLE IS NOT NULL
       ORDER BY ZPUBDATE DESC;`
    );

    const byShow = new Map();
    for (const s of shows) {
      byShow.set(s.pk, {
        pk: s.pk,
        title: s.title,
        author: s.author,
        artwork: artworkURL(s.artwork),
        episodes: [],
        downloadedCount: 0,
      });
    }

    for (const e of episodes) {
      const show = byShow.get(e.showPk);
      if (!show) continue;
      const downloaded = !!e.assetURL;
      if (downloaded) show.downloadedCount += 1;
      show.episodes.push({
        pk: e.pk,
        title: e.title,
        assetURL: e.assetURL || null,
        downloaded,
        durationSeconds: e.duration || null,
        pubDate: coreDataToISO(e.pubDate),
      });
    }

    // Surface shows that actually have something, downloaded shows first.
    const result = Array.from(byShow.values()).filter(
      (s) => s.episodes.length > 0
    );
    result.sort((a, b) => {
      if (b.downloadedCount !== a.downloadedCount) {
        return b.downloadedCount - a.downloadedCount;
      }
      return a.title.localeCompare(b.title);
    });
    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { readLibrary, libraryExists };
