'use strict';

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { fileURLToPath } = require('url');

const { sanitize } = require('./names');
const { writeDevicePlaylist, cleanDeviceJunk } = require('./device');

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

// items: [{ showTitle, episodeTitle, assetURL, pubDate }]
// options: { destDir, organizeByShow, numberPrefix, writeM3U, onProgress }
async function exportEpisodes(items, options) {
  const {
    destDir,
    organizeByShow = true,
    numberPrefix = false,
    writeM3U = true,
    onProgress = () => {},
  } = options;

  if (!fs.existsSync(destDir)) {
    throw new Error(`Destination not found: ${destDir}`);
  }

  const total = items.length;
  const written = []; // paths relative to destDir, for the m3u
  const errors = [];
  let done = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    onProgress({
      phase: 'copying',
      index: i,
      total,
      done,
      current: item.episodeTitle,
    });

    try {
      // Local files pass srcPath directly; podcasts pass a file:// assetURL.
      const srcPath = item.srcPath
        ? item.srcPath
        : fileURLToPath(item.assetURL);
      if (!fs.existsSync(srcPath)) {
        throw new Error('downloaded file is missing on disk');
      }
      const ext = path.extname(srcPath) || '.mp3';

      let targetDir = destDir;
      if (organizeByShow) {
        targetDir = path.join(destDir, sanitize(item.showTitle, 'Podcast'));
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const prefix =
        numberPrefix && total > 1
          ? String(i + 1).padStart(2, '0') + ' - '
          : '';
      const base = sanitize(prefix + item.episodeTitle, `track-${i + 1}`);
      const target = uniquePath(targetDir, base, ext);

      await pipeline(
        fs.createReadStream(srcPath),
        fs.createWriteStream(target)
      );

      written.push(path.relative(destDir, target));
      done += 1;
      onProgress({
        phase: 'copied',
        index: i,
        total,
        done,
        current: item.episodeTitle,
      });
    } catch (err) {
      errors.push({ episode: item.episodeTitle, message: err.message });
    }
  }

  // Sweep any macOS junk the drive collected from manual Finder drags, so it
  // doesn't end up in the playlist or trip up the device's player.
  try {
    await cleanDeviceJunk(destDir);
  } catch {}

  // Regenerate the single canonical playlist from the destination's current
  // contents, so it reflects this export plus whatever was already there.
  let playlistPath = null;
  if (writeM3U && done > 0) {
    try {
      playlistPath = await writeDevicePlaylist(destDir);
    } catch {}
  }

  onProgress({ phase: 'done', total, done });
  return { copied: done, total, errors, playlistPath };
}

module.exports = { exportEpisodes, sanitize };
