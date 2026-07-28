import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseMessage, parseVerdict } from '../src/judge.js';

const VERDICT = {
  complete: false,
  confidence: 0.9,
  unfinished: ['the tests'],
  reason: 'only the parser was written',
  blocked: false,
  blocked_kind: 'none',
  message: 'Not done yet - the tests are missing. Add them and run npm test.',
};

test('a bare verdict object parses', () => {
  const v = parseVerdict(JSON.stringify(VERDICT));
  assert.equal(v?.complete, false);
  assert.equal(v?.confidence, 0.9);
  assert.deepEqual(v?.unfinished, ['the tests']);
});

test('a verdict inside the CLI result envelope parses', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(VERDICT) });
  assert.equal(parseVerdict(raw)?.complete, false);
});

test('a verdict inside a markdown fence parses', () => {
  const raw = JSON.stringify({
    type: 'result',
    result: '```json\n' + JSON.stringify(VERDICT) + '\n```',
  });
  assert.equal(parseVerdict(raw)?.reason, 'only the parser was written');
});

test('a verdict surrounded by prose parses', () => {
  const raw = `Here is my assessment.\n\n${JSON.stringify(VERDICT)}\n\nLet me know.`;
  assert.equal(parseVerdict(raw)?.complete, false);
});

test('nested braces inside strings do not break the scanner', () => {
  const nested = { ...VERDICT, message: 'fix the `{ a: 1 }` literal in src/x.ts' };
  const v = parseVerdict(`prose ${JSON.stringify(nested)} more prose`);
  assert.match(v?.message ?? '', /\{ a: 1 \}/);
});

test('a blocked agent is treated as complete whatever the model said', () => {
  const v = parseVerdict(
    JSON.stringify({ ...VERDICT, complete: false, blocked: true, blocked_kind: 'authority' }),
  );
  assert.equal(v?.complete, true, 'needing a person means the turn correctly ended');
  assert.equal(v?.blocked, true);
  assert.equal(v?.blockedKind, 'authority');
});

test('an unrecognised blocked_kind falls back to none', () => {
  const v = parseVerdict(JSON.stringify({ ...VERDICT, blocked: true, blocked_kind: 'vibes' }));
  assert.equal(v?.blockedKind, 'none');
});

test('junk, prose and half-objects yield no verdict rather than a wrong one', () => {
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('the agent seems fine to me'), null);
  assert.equal(parseVerdict('{"confidence": 0.9}'), null, 'no `complete` field means no verdict');
  assert.equal(parseVerdict('{"complete":'), null);
});

test('confidence is clamped and defaulted', () => {
  assert.equal(parseVerdict(JSON.stringify({ ...VERDICT, confidence: 7 }))?.confidence, 1);
  assert.equal(parseVerdict(JSON.stringify({ ...VERDICT, confidence: -3 }))?.confidence, 0);
  assert.equal(parseVerdict(JSON.stringify({ ...VERDICT, confidence: 'high' }))?.confidence, 0.5);
});

test('house style is enforced on the message, not merely requested', () => {
  const text = normaliseMessage('Not done — the tests are missing! Add them!!');
  assert.ok(!text.includes('—'), 'em-dashes must be replaced');
  assert.ok(!text.includes('!'), 'exclamation marks must be replaced');
  assert.match(text, /Not done - the tests/);
});

test('a runaway message is truncated', () => {
  const text = normaliseMessage('word '.repeat(2000));
  assert.ok(text.length <= 1_205, `got ${text.length}`);
  assert.ok(text.endsWith('...'));
});

test('a non-string message becomes empty rather than "undefined"', () => {
  assert.equal(normaliseMessage(undefined), '');
  assert.equal(normaliseMessage(42), '');
});
