# LapPods 🎧

A small macOS desktop app to copy audio onto your **Shokz OpenSwim Pro** (or any
USB drive / SD card / folder) from two sources, without opening other apps:

- **Podcasts** — browse your Apple Podcasts library and export downloaded episodes.
- **Files** — scan your Mac (Downloads, Music, Desktop, or any folder you add) for
  loose MP3/M4A/WAV/FLAC/etc. and send them over too.

## What it does

- **Podcasts tab:** reads your Apple Podcasts library directly (shows, episodes,
  metadata) without launching Podcasts; only downloaded episodes are exportable.
- **Files tab:** scans chosen folders for supported audio, reads embedded tags
  (title/artist/album/duration), groups results by folder, and flags
  DRM-protected Apple Music `.m4p` files as non-exportable.
- Auto-detects the Shokz drive when it's plugged in (`SWIM PRO`), or lets you
  pick any folder. Click ⟳ to re-detect after plugging the drive in.
- Copies selected files with clean, player-safe filenames (sanitized for FAT32).
- Optionally groups into a folder per show/source, numbers tracks, and writes an
  `.m3u` playlist for media players that want one.

## Requirements

- macOS (uses the Apple Podcasts group container + the system `sqlite3`).
- Node.js 18+ (only to run/build; the app shells out to the built-in `sqlite3`).
- Episodes must be **downloaded** in Apple Podcasts — only downloaded episodes
  have a local file to copy. Streaming-only episodes are shown but not exportable.

## Run it

```bash
npm install
npm start
```

## Build a .app / .dmg

```bash
npm run dist
```

The packaged app lands in `dist/`, using the branded icon at `build/icon.icns`.

## App icon

The branded icon (swimmer + headphones over a wave) is generated from
`build/icon-source.png`. To regenerate after changing the source art:

```bash
npm run icons
```

This trims the artwork, rounds the corners with transparency, and emits
`build/icon.icns` (app bundle), `build/icon.png` (dev dock icon), and
`src/renderer/assets/logo.png` (in-app header). Uses `sharp` + `iconutil`.

## How it works

| Concern | Approach |
| --- | --- |
| Reading the library | Copies `MTLibrary.sqlite` (+ `-wal`/`-shm`) to a temp dir, then queries it read-only via the macOS `sqlite3` CLI in JSON mode. The live database is never locked or modified. |
| Finding episode files | Each downloaded episode stores a `file://` path in `ZASSETURL` pointing at the cached audio in the Podcasts container. |
| Drive detection | Scans `/Volumes`, uses `diskutil` to keep removable/external volumes, and flags Shokz devices by name. |
| Safe copies | Streams files, sanitizes names for FAT32 (`:/\*?"<>|` stripped), de-duplicates collisions, and reports per-file progress. |

## Project layout

```
src/
  main.js            Electron main process + IPC
  preload.js         contextBridge API exposed to the UI
  lib/
    podcasts.js      Reads the Apple Podcasts SQLite library
    scanner.js       Scans folders for audio + reads embedded tags
    drives.js        Detects mounted drives / the Shokz device
    exporter.js      Copies files, sanitizes names, writes .m3u
  renderer/
    index.html       UI markup
    styles.css       Styling
    renderer.js      UI logic
```

## Notes & roadmap ideas

- **No conversion yet.** The OpenSwim Pro plays MP3/AAC/M4A/WAV/FLAC natively, so
  files copy as-is. An optional ffmpeg-based "convert to MP3" step could be added.
- Possible future additions: drag-and-drop of arbitrary audio files, audiobook
  (`.m4b`) chapter handling, remembering last-used destination, and a "remove from
  drive" view.
