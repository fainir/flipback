import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from '../src/decide.js';
import type { Verdict } from '../src/judge.js';
import { assistant, testConfig, toolResult, toolUse, user, writeTranscript } from './helpers.js';

/**
 * Turns whose request has scrolled out of the readable window.
 *
 * Every verdict flipback reaches is "did this turn do what was asked", so with no request there
 * is nothing to measure against. Found on a real transcript whose session died mid-run: the last
 * entry was an API limit notice and there was no user turn behind it in the tail.
 */

const INCOMPLETE: Verdict = {
  complete: false,
  confidence: 0.9,
  unfinished: ['something'],
  reason: 'graded on the final message alone',
  blocked: false,
  blockedKind: 'none',
  message: 'Not done yet - keep going.',
};

const payload = (transcript: string) => ({
  transcript_path: transcript,
  session_id: 'no-request',
  stop_hook_active: false,
});

test('a turn with no readable request is never judged, however suspicious it looks', async () => {
  let judged = false;
  // Every one of these would trip the prefilter if a request were present.
  const transcript = writeTranscript([
    assistant('Added the parser. Let me now write the tests and update the README.'),
    toolUse('t1', 'Write', { file_path: 'src/parse.ts' }),
    toolResult('t1', 'ok'),
    assistant('There is still a TODO in the validation path. Would you like me to continue?'),
  ]);

  const decision = await decide(payload(transcript), testConfig(), {
    judge: async () => {
      judged = true;
      return { verdict: INCOMPLETE, durationMs: 1 };
    },
  });

  assert.equal(judged, false, 'judging completion against an unknown request is unsound');
  assert.equal(decision.action, 'allow');
});

test('the reason is specific, so the log shows it rather than hiding it', async () => {
  const transcript = writeTranscript([
    assistant("You've hit your limit, resets at 10:10pm. Let me retry that shortly."),
  ]);
  const decision = await decide(payload(transcript), testConfig(), {
    judge: async () => ({ verdict: INCOMPLETE, durationMs: 1 }),
  });
  assert.match(decision.why, /no user request/);
});

test('the same turn with a request present is judged normally', async () => {
  let judged = false;
  const transcript = writeTranscript([
    user('write the parser and then the tests'),
    assistant('Added the parser. Let me now write the tests and update the README.'),
  ]);

  await decide(payload(transcript), testConfig(), {
    judge: async () => {
      judged = true;
      return { verdict: INCOMPLETE, durationMs: 1 };
    },
  });

  assert.equal(judged, true, 'the guard must not disable flipback on ordinary turns');
});
