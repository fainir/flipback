import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readSlice, readHookInput } from '../src/transcript.js';
import { assistant, meta, toolResult, toolUse, user, writeTranscript } from './helpers.js';
import { Readable } from 'node:stream';

test('reads the last genuine user message as the request', () => {
  const file = writeTranscript([
    user('first thing'),
    assistant('done'),
    user('second thing'),
    assistant('also done'),
  ]);
  const slice = readSlice(file);
  assert.equal(slice.userRequest, 'second thing');
  assert.equal(slice.userMessageCount, 2);
});

test('tool results are not mistaken for the user speaking', () => {
  const file = writeTranscript([
    user('run the build'),
    toolUse('t1', 'Bash', { command: 'npm run build' }),
    toolResult('t1', 'built ok'),
    assistant('built'),
  ]);
  const slice = readSlice(file);
  assert.equal(slice.userRequest, 'run the build');
  assert.equal(slice.userMessageCount, 1, 'the tool result must not count as a user turn');
});

test('system reminders are stripped out of the request', () => {
  const file = writeTranscript([
    user('fix the bug <system-reminder>some injected note</system-reminder> in parse()'),
    assistant('fixed'),
  ]);
  assert.equal(readSlice(file).userRequest, 'fix the bug  in parse()');
});

test('isMeta entries are ignored entirely', () => {
  const file = writeTranscript([user('real request'), meta('injected'), assistant('ok')]);
  const slice = readSlice(file);
  assert.equal(slice.userRequest, 'real request');
  assert.equal(slice.userMessageCount, 1);
});

test('failed tool results are joined back onto the call that made them', () => {
  const file = writeTranscript([
    user('build it'),
    toolUse('t1', 'Bash', { command: 'npm run build' }),
    toolResult('t1', 'TS2307: cannot find module', true),
    assistant('the build failed'),
  ]);
  const slice = readSlice(file);
  assert.equal(slice.toolCalls.length, 1);
  assert.equal(slice.toolCalls[0]?.failed, true);
  assert.match(slice.toolCalls[0]?.errorText ?? '', /TS2307/);
  assert.match(slice.toolCalls[0]?.summary ?? '', /npm run build/);
});

test('endedOnText distinguishes a turn that finished talking from one that finished acting', () => {
  const talking = writeTranscript([user('x'), toolUse('t1', 'Read', { file_path: 'a.ts' }), assistant('here it is')]);
  assert.equal(readSlice(talking).endedOnText, true);

  const acting = writeTranscript([user('x'), assistant('reading now'), toolUse('t1', 'Read', { file_path: 'a.ts' })]);
  assert.equal(readSlice(acting).endedOnText, false);
});

test('only assistant output after the last user message is collected', () => {
  const file = writeTranscript([
    user('one'),
    assistant('answer to one'),
    user('two'),
    assistant('answer to two'),
  ]);
  const slice = readSlice(file);
  assert.equal(slice.assistantText, 'answer to two');
  assert.equal(slice.lastAssistantText, 'answer to two');
});

test('a malformed line does not sink the whole read', () => {
  const good = writeTranscript([user('hello'), assistant('hi')]);
  fs.appendFileSync(good, '{ not json at all\n');
  fs.appendFileSync(good, `${JSON.stringify(assistant('still here'))}\n`);
  assert.equal(readSlice(good).lastAssistantText, 'still here');
});

test('a missing transcript returns an empty slice rather than throwing', () => {
  const slice = readSlice('/definitely/not/a/real/path.jsonl');
  assert.equal(slice.userRequest, '');
  assert.equal(slice.toolCalls.length, 0);
});

test('hook input parses, and garbage yields an empty object', async () => {
  assert.deepEqual(await readHookInput(Readable.from(['{"session_id":"abc"}'])), {
    session_id: 'abc',
  });
  assert.deepEqual(await readHookInput(Readable.from(['not json'])), {});
  assert.deepEqual(await readHookInput(Readable.from([''])), {});
});
