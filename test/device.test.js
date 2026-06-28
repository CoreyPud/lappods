'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const {
  listDevice,
  deviceKeys,
  removeFromDevice,
  writeDevicePlaylist,
  cleanDeviceJunk,
  CANONICAL_PLAYLIST,
} = require('../src/lib/device');
const { fileKey } = require('../src/lib/names');

// Builds a throwaway "device" with a couple of show folders and a root file.
async function makeFixture() {
  const mount = await fsp.mkdtemp(path.join(os.tmpdir(), 'lappods-dev-'));
  await fsp.mkdir(path.join(mount, 'ShowA'));
  await fsp.mkdir(path.join(mount, 'ShowB'));
  await fsp.writeFile(path.join(mount, 'ShowA', 'ep1.mp3'), 'a');
  await fsp.writeFile(path.join(mount, 'ShowA', 'ep2.mp3'), 'a');
  await fsp.writeFile(path.join(mount, 'ShowB', 'only.mp3'), 'a');
  await fsp.writeFile(path.join(mount, 'root.mp3'), 'a');
  return mount;
}

test('removeFromDevice deletes targeted files and reports them', async () => {
  const mount = await makeFixture();
  const target = path.join(mount, 'ShowA', 'ep1.mp3');

  const res = await removeFromDevice(mount, [target]);

  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(res.removed, [target]);
  assert.strictEqual(fs.existsSync(target), false);
  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowA', 'ep2.mp3')), true);
});

test('removing the last file in a folder prunes that folder only', async () => {
  // Covers AE3: deleting the only file in a show folder removes the folder.
  const mount = await makeFixture();

  await removeFromDevice(mount, [path.join(mount, 'ShowB', 'only.mp3')]);

  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowB')), false, 'emptied folder pruned');
  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowA')), true, 'non-empty sibling kept');
  assert.strictEqual(fs.existsSync(mount), true, 'mount root never removed');
});

test('a path outside the mount is refused with no deletion', async () => {
  const mount = await makeFixture();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'lappods-out-'));
  const outsideFile = path.join(outside, 'keep.mp3');
  await fsp.writeFile(outsideFile, 'a');

  const res = await removeFromDevice(mount, [outsideFile]);

  assert.deepStrictEqual(res.removed, []);
  assert.strictEqual(res.errors.length, 1);
  assert.match(res.errors[0].message, /outside device/);
  assert.strictEqual(fs.existsSync(outsideFile), true);
});

test('deviceKeys returns keys for nested and root files alike', async () => {
  // Covers AE2: match key is by base name, regardless of folder nesting.
  const mount = await makeFixture();

  const keys = await deviceKeys(mount);

  assert.ok(keys.includes(fileKey('ep1.mp3')), 'nested file keyed');
  assert.ok(keys.includes(fileKey('root.mp3')), 'root file keyed');
  assert.strictEqual(keys.length, new Set(keys).size, 'keys are de-duplicated');
});

test('listDevice with no mount returns an empty result', async () => {
  const res = await listDevice(null);
  assert.deepStrictEqual(res, { groups: [], fileCount: 0, roots: [] });
});

test('cleanDeviceJunk removes ._* and .DS_Store but leaves real audio', async () => {
  const mount = await makeFixture();
  // Junk that accumulates from manual Finder drags, at root and nested.
  await fsp.writeFile(path.join(mount, '.DS_Store'), 'junk');
  await fsp.writeFile(path.join(mount, '._x.mp3'), 'junk');
  await fsp.writeFile(path.join(mount, 'ShowA', '.DS_Store'), 'junk');
  await fsp.writeFile(path.join(mount, 'ShowA', '._ep1.mp3'), 'junk');

  const res = await cleanDeviceJunk(mount);

  assert.deepStrictEqual(res.errors, []);
  assert.strictEqual(res.removed.length, 4);
  assert.strictEqual(fs.existsSync(path.join(mount, '.DS_Store')), false);
  assert.strictEqual(fs.existsSync(path.join(mount, '._x.mp3')), false);
  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowA', '.DS_Store')), false);
  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowA', '._ep1.mp3')), false);
  // Real audio is untouched, including the file the sidecar shadowed.
  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowA', 'ep1.mp3')), true);
  assert.strictEqual(fs.existsSync(path.join(mount, 'root.mp3')), true);
});

test('listDevice sweeps macOS junk before scanning', async () => {
  const mount = await makeFixture();
  await fsp.writeFile(path.join(mount, 'ShowA', '._ep1.mp3'), 'junk');

  await listDevice(mount);

  assert.strictEqual(fs.existsSync(path.join(mount, 'ShowA', '._ep1.mp3')), false);
});

test('writeDevicePlaylist lists current audio with device-relative paths', async () => {
  const mount = await makeFixture();

  const playlistPath = await writeDevicePlaylist(mount);

  assert.strictEqual(playlistPath, path.join(mount, CANONICAL_PLAYLIST));
  const body = await fsp.readFile(playlistPath, 'utf8');
  assert.ok(body.startsWith('#EXTM3U'));
  assert.ok(body.includes('ShowA/ep1.mp3'), 'device-relative POSIX path');
  assert.ok(body.includes('root.mp3'));
  assert.ok(body.includes('\r\n'), 'CRLF line endings');
});

test('regenerating after a removal drops the file from the playlist', async () => {
  const mount = await makeFixture();
  await writeDevicePlaylist(mount);

  await removeFromDevice(mount, [path.join(mount, 'ShowB', 'only.mp3')]);

  const body = await fsp.readFile(path.join(mount, CANONICAL_PLAYLIST), 'utf8');
  assert.ok(!body.includes('only.mp3'), 'removed track gone from playlist');
  assert.ok(body.includes('ShowA/ep1.mp3'), 'remaining tracks kept');
});

test('regenerating overwrites rather than creating a second playlist', async () => {
  const mount = await makeFixture();
  await writeDevicePlaylist(mount);
  await writeDevicePlaylist(mount);

  const entries = await fsp.readdir(mount);
  const playlists = entries.filter((e) => e.endsWith('.m3u'));
  assert.deepStrictEqual(playlists, [CANONICAL_PLAYLIST]);
});

test('onlyIfExists refreshes an existing playlist but never creates one', async () => {
  const mount = await makeFixture();

  const created = await writeDevicePlaylist(mount, { onlyIfExists: true });
  assert.strictEqual(created, null, 'no playlist created from nothing');
  assert.strictEqual(fs.existsSync(path.join(mount, CANONICAL_PLAYLIST)), false);

  await writeDevicePlaylist(mount); // now one exists
  const refreshed = await writeDevicePlaylist(mount, { onlyIfExists: true });
  assert.strictEqual(refreshed, path.join(mount, CANONICAL_PLAYLIST));
});
