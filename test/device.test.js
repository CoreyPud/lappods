'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { listDevice, deviceKeys, removeFromDevice } = require('../src/lib/device');
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
