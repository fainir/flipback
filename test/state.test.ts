import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { continuesSpent, prune, readState, recordContinue } from '../src/state.js';
import { tempDir } from './helpers.js';

test('an unseen session has spent nothing', () => {
  assert.equal(continuesSpent(tempDir(), 'fresh', 1), 0);
});

test('nudges accumulate within one user turn', () => {
  const dir = tempDir();
  assert.equal(recordContinue(dir, 's', 1), 1);
  assert.equal(recordContinue(dir, 's', 1), 2);
  assert.equal(continuesSpent(dir, 's', 1), 2);
});

test('a new user message resets the count', () => {
  const dir = tempDir();
  recordContinue(dir, 's', 1);
  recordContinue(dir, 's', 1);
  assert.equal(continuesSpent(dir, 's', 2), 0);
  assert.equal(recordContinue(dir, 's', 2), 1);
});

test('a shrinking user-message count does not hand out a fresh budget', () => {
  // Happens when the transcript tail read reaches further back on one call than the next. It is
  // not a new request, so the ceiling has to survive it.
  const dir = tempDir();
  recordContinue(dir, 's', 12);
  recordContinue(dir, 's', 12);
  assert.equal(continuesSpent(dir, 's', 9), 2);
});

test('sessions do not share a budget', () => {
  const dir = tempDir();
  recordContinue(dir, 'a', 1);
  recordContinue(dir, 'a', 1);
  assert.equal(continuesSpent(dir, 'b', 1), 0);
});

test('a session id cannot escape the state directory', () => {
  const dir = tempDir();
  recordContinue(dir, '../../etc/passwd', 1);
  const written = fs.readdirSync(path.join(dir, 'sessions'));
  assert.equal(written.length, 1);
  assert.ok(!written[0]?.includes('/'), `unsafe filename: ${written[0]}`);
  assert.ok(!written[0]?.includes('..'), `unsafe filename: ${written[0]}`);
});

test('corrupt state reads as empty instead of throwing', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sessions', 'x.json'), 'not json');
  assert.deepEqual(readState(dir, 'x'), { continues: 0, userMessages: 0, updatedAt: 0 });
});

test('an unwritable state directory does not throw', () => {
  assert.doesNotThrow(() => recordContinue('/proc/definitely-not-writable', 's', 1));
});

test('prune drops stale sessions and keeps fresh ones', () => {
  const dir = tempDir();
  recordContinue(dir, 'old', 1);
  recordContinue(dir, 'new', 1);
  const oldFile = path.join(dir, 'sessions', 'old.json');
  const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, ancient / 1000, ancient / 1000);

  prune(dir);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(path.join(dir, 'sessions', 'new.json')), true);
});
