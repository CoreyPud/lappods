'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { sanitize, fileKey, titleKey } = require('../src/lib/names');

test('fileKey strips extension so a title matches its exported file', () => {
  // Covers AE2: dedup works regardless of which audio extension was written.
  assert.strictEqual(fileKey('My Episode.mp3'), titleKey('My Episode'));
  assert.strictEqual(fileKey('My Episode.m4a'), titleKey('My Episode'));
  assert.strictEqual(fileKey('My Episode.mp3'), fileKey('My Episode.m4a'));
});

test('fileKey strips a leading track-number prefix', () => {
  // Files exported with "Number tracks" on still match the bare title.
  assert.strictEqual(fileKey('03 - My Episode.mp3'), titleKey('My Episode'));
  assert.strictEqual(fileKey('12 - My Episode.mp3'), fileKey('My Episode.mp3'));
});

test('matching is case-insensitive and normalizes FAT32-illegal chars', () => {
  // A colon in the title becomes a space at export; the key must agree.
  assert.strictEqual(fileKey('S1 The End.mp3'), titleKey('S1: The End'));
  assert.strictEqual(titleKey('My EPISODE'), titleKey('my episode'));
});

test('titleKey keeps a dotted title intact (no false extension strip)', () => {
  // "Ep 4.5" must not lose ".5"; the exported file is "Ep 4.5.mp3".
  assert.strictEqual(fileKey('Ep 4.5.mp3'), titleKey('Ep 4.5'));
  assert.notStrictEqual(titleKey('Ep 4.5'), titleKey('Ep 4'));
});

test('fileKey ignores the containing folder', () => {
  // Covers AE2: match is by base name, independent of show-folder nesting.
  assert.strictEqual(fileKey('Some Show/My Episode.mp3'), fileKey('My Episode.mp3'));
});

test('empty or garbage input yields an empty key (never matches)', () => {
  assert.strictEqual(titleKey(''), '');
  assert.strictEqual(titleKey(null), '');
  assert.strictEqual(fileKey('.mp3'), '');
});

test('sanitize still returns its prior output (guards the move from exporter)', () => {
  assert.strictEqual(sanitize('a/b:c*d?'), 'a b c d');
  assert.strictEqual(sanitize(''), 'untitled');
  assert.strictEqual(sanitize('trailing.  '), 'trailing');
  assert.strictEqual(sanitize('x'.repeat(200)).length, 120);
});
