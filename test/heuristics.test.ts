import assert from 'node:assert/strict';
import test from 'node:test';
import { prefilter } from '../src/heuristics.js';
import { EMPTY_SLICE, type Slice } from '../src/transcript.js';

const slice = (over: Partial<Slice>): Slice => ({
  ...EMPTY_SLICE,
  userRequest: 'do the thing',
  endedOnText: true,
  ...over,
});

const ids = (s: Slice) => prefilter(s).signals.map((x) => x.id);

test('announced work that never happened is a strong signal', () => {
  const s = slice({ lastAssistantText: 'I have added the parser. Let me run the tests now.' });
  assert.ok(ids(s).includes('announced-not-done'));
  assert.equal(prefilter(s).suspicious, true);
});

test('the same words are not a signal when the turn ended on a tool call', () => {
  const s = slice({
    lastAssistantText: 'Let me run the tests now.',
    endedOnText: false,
    toolCalls: [{ name: 'Bash', summary: 'command=npm test', failed: false }],
  });
  assert.ok(!ids(s).includes('announced-not-done'));
});

test('a question to the user at the end of a turn is a strong signal', () => {
  for (const text of [
    'I stopped here. Would you like me to continue with the migration?',
    'Should I also update the docs?',
    'Let me know if you want the tests too.',
  ]) {
    assert.ok(prefilter(slice({ lastAssistantText: text })).suspicious, text);
  }
});

test('admissions of unfinished work are caught', () => {
  for (const text of [
    'Added the handler with a TODO for validation.',
    'The auth check is a placeholder for now.',
    'This is not yet implemented for the async path.',
  ]) {
    assert.ok(prefilter(slice({ lastAssistantText: text })).suspicious, text);
  }
});

test('an unchecked checklist in the final message is a signal', () => {
  const s = slice({ lastAssistantText: 'Progress:\n- [x] parser\n- [ ] tests\n- [ ] docs' });
  assert.ok(ids(s).includes('unchecked-checklist'));
});

test('handing scope back to the user is a signal', () => {
  const s = slice({
    lastAssistantText: 'I have done the API. The frontend felt out of scope so you can then wire it up.',
  });
  assert.ok(ids(s).includes('declines-scope'));
});

test('ending on a failed tool call is a signal even with a calm summary', () => {
  const s = slice({
    lastAssistantText: 'The build did not complete.',
    toolCalls: [{ name: 'Bash', summary: 'command=npm run build', failed: true }],
  });
  assert.ok(ids(s).includes('ended-on-failure'));
  assert.equal(prefilter(s).suspicious, true);
});

test('two weak signals add up to a look', () => {
  const s = slice({
    userRequest: 'add the parser, and then write tests, and also update the readme',
    lastAssistantText: 'Here is a basic version of the parser. It should work.',
    toolCalls: [{ name: 'Write', summary: 'file_path=src/parse.ts', failed: false }],
  });
  const result = prefilter(s);
  assert.ok(result.score >= 2, `expected weak signals to accumulate, got ${result.score}`);
  assert.equal(result.suspicious, true);
});

test('an explicit user stop overrides everything', () => {
  const s = slice({
    userRequest: 'that is enough, stop here',
    lastAssistantText: 'Sure. I left the tests as a TODO. Would you like me to continue?',
  });
  const result = prefilter(s);
  assert.equal(result.suspicious, false);
  assert.deepEqual(
    result.signals.map((x) => x.id),
    ['user-said-stop'],
  );
});

test('a verified clean run pulls the score down', () => {
  const s = slice({
    userRequest: 'add the parser, and then write tests, and also update the readme',
    lastAssistantText: 'Parser, tests and readme are all done. All 14 tests pass.',
    toolCalls: [
      { name: 'Write', summary: 'file_path=src/parse.ts', failed: false },
      { name: 'Bash', summary: 'command=npm test', failed: false },
    ],
  });
  assert.ok(prefilter(s).signals.some((x) => x.id === 'verified-clean'));
  assert.equal(prefilter(s).suspicious, false);
});

test('a claim of passing tests with no command run is not trusted', () => {
  const s = slice({
    lastAssistantText: 'All tests pass. I left the edge cases as a TODO.',
    toolCalls: [{ name: 'Edit', summary: 'file_path=src/a.ts', failed: false }],
  });
  const result = prefilter(s);
  assert.ok(!result.signals.some((x) => x.id === 'verified-clean'));
  assert.ok(result.signals.some((x) => x.id === 'unverified-edit'));
});

test('an ordinary finished turn produces nothing', () => {
  const s = slice({
    userRequest: 'rename the variable',
    lastAssistantText: 'Renamed `cfg` to `config` across src/server.ts and its two call sites.',
    toolCalls: [{ name: 'Edit', summary: 'file_path=src/server.ts', failed: false }],
  });
  const result = prefilter(s);
  assert.equal(result.suspicious, false, `unexpected signals: ${ids(s).join(', ')}`);
});
