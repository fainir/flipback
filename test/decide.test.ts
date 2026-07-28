import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, type Deps } from '../src/decide.js';
import type { JudgeOutcome, Verdict } from '../src/judge.js';
import { assistant, testConfig, toolResult, toolUse, user, writeTranscript } from './helpers.js';

const INCOMPLETE: Verdict = {
  complete: false,
  confidence: 0.9,
  unfinished: ['the tests'],
  reason: 'only the parser was written',
  blocked: false,
  blockedKind: 'none',
  message: 'Not done yet - the tests are missing. Add them and run npm test.',
};

const COMPLETE: Verdict = {
  ...INCOMPLETE,
  complete: true,
  unfinished: [],
  reason: 'everything asked for exists',
  message: '',
};

const verdictFrom = (verdict: Verdict | null, error?: string) =>
  async (): Promise<JudgeOutcome> => ({ verdict, error, durationMs: 5 });

/** A turn that trips the prefilter, so tests reach the judge without fighting the heuristics. */
function suspiciousTranscript(): string {
  return writeTranscript([
    user('write the parser and then the tests'),
    toolUse('t1', 'Write', { file_path: 'src/parse.ts' }),
    toolResult('t1', 'ok'),
    assistant('Added the parser. Let me now write the tests for it.'),
  ]);
}

function payload(transcript: string, over: Record<string, unknown> = {}) {
  return { transcript_path: transcript, session_id: 's1', stop_hook_active: false, ...over };
}

const deps = (over: Partial<Deps> = {}): Partial<Deps> => ({
  judge: verdictFrom(INCOMPLETE),
  ...over,
});

test('an incomplete turn is blocked with the judge message', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig(), deps());
  assert.equal(d.action, 'block');
  assert.match(d.action === 'block' ? d.message : '', /the tests are missing/);
  assert.match(d.action === 'block' ? d.message : '', /flipback 1\/3/);
});

test('the block message tells the agent how to disagree', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig(), deps());
  assert.match(d.action === 'block' ? d.message : '', /If this is wrong/);
});

test('a complete turn is allowed', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig(), deps({ judge: verdictFrom(COMPLETE) }));
  assert.equal(d.action, 'allow');
});

test('running inside the judge subprocess is always allowed', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig(), {
    ...deps(),
    env: { FLIPBACK_JUDGE: '1' },
  });
  assert.equal(d.action, 'allow');
  assert.match(d.why, /judge/);
});

test('mode off allows without reading anything', async () => {
  let judged = false;
  const d = await decide(payload(suspiciousTranscript()), testConfig({ mode: 'off' }), {
    judge: async () => {
      judged = true;
      return { verdict: INCOMPLETE, durationMs: 1 };
    },
  });
  assert.equal(d.action, 'allow');
  assert.equal(judged, false);
});

test('a judge that could not run never blocks', async () => {
  for (const error of ['`claude` is not on PATH', 'judge timed out after 45000ms']) {
    const d = await decide(
      payload(suspiciousTranscript()),
      testConfig(),
      deps({ judge: verdictFrom(null, error) }),
    );
    assert.equal(d.action, 'allow', error);
    assert.equal(d.why, error);
  }
});

test('an unsure judge does not force more work', async () => {
  const d = await decide(
    payload(suspiciousTranscript()),
    testConfig(),
    deps({ judge: verdictFrom({ ...INCOMPLETE, confidence: 0.2 }) }),
  );
  assert.equal(d.action, 'allow');
  assert.match(d.why, /unsure/);
});

test('an incomplete verdict with no message allows rather than nudging emptily', async () => {
  const d = await decide(
    payload(suspiciousTranscript()),
    testConfig(),
    deps({ judge: verdictFrom({ ...INCOMPLETE, message: '   ' }) }),
  );
  assert.equal(d.action, 'allow');
});

test('an unremarkable turn never reaches the judge', async () => {
  let judged = false;
  const transcript = writeTranscript([
    user('rename cfg to config'),
    toolUse('t1', 'Edit', { file_path: 'src/server.ts' }),
    toolResult('t1', 'ok'),
    toolUse('t2', 'Bash', { command: 'npm test' }),
    toolResult('t2', '14 passing'),
    assistant('Renamed `cfg` to `config` in src/server.ts and its two call sites. All 14 tests pass.'),
  ]);
  const d = await decide(payload(transcript), testConfig(), {
    judge: async () => {
      judged = true;
      return { verdict: INCOMPLETE, durationMs: 1 };
    },
  });
  assert.equal(d.action, 'allow');
  assert.equal(judged, false, 'the prefilter should have kept this free');
});

test('mode always sends even an unremarkable turn to the judge', async () => {
  let judged = false;
  const transcript = writeTranscript([user('rename it'), assistant('Renamed it in src/server.ts, and the two call sites that referenced it.')]);
  await decide(payload(transcript), testConfig({ mode: 'always' }), {
    judge: async () => {
      judged = true;
      return { verdict: COMPLETE, durationMs: 1 };
    },
  });
  assert.equal(judged, true);
});

test('the nudge budget is spent and then respected', async () => {
  const config = testConfig({ maxContinues: 2 });
  const transcript = suspiciousTranscript();

  const first = await decide(payload(transcript), config, deps());
  assert.equal(first.action, 'block');
  assert.equal(first.action === 'block' ? first.nudge : 0, 1);

  const second = await decide(payload(transcript, { stop_hook_active: true }), config, deps());
  assert.equal(second.action, 'block');
  assert.equal(second.action === 'block' ? second.nudge : 0, 2);

  const third = await decide(payload(transcript, { stop_hook_active: true }), config, deps());
  assert.equal(third.action, 'allow', 'the budget must be a real ceiling');
  assert.match(third.why, /budget/);
});

test('a new user message resets the budget', async () => {
  const config = testConfig({ maxContinues: 1 });
  const first = await decide(payload(suspiciousTranscript()), config, deps());
  assert.equal(first.action, 'block');

  // Same session, one more thing asked: this is a different piece of work.
  const nextTurn = writeTranscript([
    user('write the parser and then the tests'),
    assistant('Added the parser.'),
    user('now also add the docs'),
    toolUse('t9', 'Write', { file_path: 'docs.md' }),
    toolResult('t9', 'ok'),
    assistant('Added a docs page. Let me now check the links resolve.'),
  ]);
  const second = await decide(payload(nextTurn), config, deps());
  assert.equal(second.action, 'block', 'a fresh request gets a fresh budget');
});

test('a lost nudge counter degrades to one nudge per turn rather than unbounded', async () => {
  const d = await decide(payload(suspiciousTranscript(), { stop_hook_active: true }), testConfig(), {
    ...deps(),
    continuesSpent: () => 0,
  });
  assert.equal(d.action, 'allow');
  assert.match(d.why, /counter is unavailable/);
});

test('an unreadable transcript is allowed', async () => {
  const d = await decide(payload('/nope/missing.jsonl'), testConfig(), deps());
  assert.equal(d.action, 'allow');
});

test('a hook payload with no transcript path is allowed', async () => {
  const d = await decide({ session_id: 's1' }, testConfig(), deps());
  assert.equal(d.action, 'allow');
});

test('a very short turn is not worth judging', async () => {
  const transcript = writeTranscript([user('hi'), assistant('Hello.')]);
  const d = await decide(payload(transcript), testConfig(), deps());
  assert.equal(d.action, 'allow');
  assert.match(d.why, /too short/);
});

test('a short turn that ended on a failed tool call is still judged', async () => {
  let judged = false;
  const transcript = writeTranscript([
    user('build it'),
    assistant('Building.'),
    toolUse('t1', 'Bash', { command: 'npm run build' }),
    toolResult('t1', 'TS2307', true),
  ]);
  await decide(payload(transcript), testConfig(), {
    judge: async () => {
      judged = true;
      return { verdict: INCOMPLETE, durationMs: 1 };
    },
  });
  assert.equal(judged, true);
});

test('heuristic mode blocks with the signals it actually saw and never spawns a judge', async () => {
  let judged = false;
  const d = await decide(payload(suspiciousTranscript()), testConfig({ mode: 'heuristic' }), {
    judge: async () => {
      judged = true;
      return { verdict: INCOMPLETE, durationMs: 1 };
    },
  });
  assert.equal(judged, false);
  assert.equal(d.action, 'block');
  assert.match(d.action === 'block' ? d.message : '', /announces an action that never happened/);
});

// ---------------------------------------------------------------------------
// optional human escalation
// ---------------------------------------------------------------------------

const BLOCKED: Verdict = {
  ...COMPLETE,
  blocked: true,
  blockedKind: 'authority',
  reason: 'deploying to production needs a person',
  unfinished: ['deploy to production'],
};

test('with no key configured a blocked agent is simply allowed to stop', async () => {
  let escalated = false;
  const d = await decide(payload(suspiciousTranscript()), testConfig({ hitlKey: '' }), {
    judge: verdictFrom(BLOCKED),
    escalate: async () => {
      escalated = true;
      return null;
    },
  });
  assert.equal(escalated, false);
  assert.equal(d.action, 'allow');
});

test('a human answer unblocks the agent and it continues', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig({ hitlKey: 'k' }), {
    judge: verdictFrom(BLOCKED),
    escalate: async () => ({
      outcome: 'answered',
      requestId: 'req_1',
      answer: 'APPROVED\nGo ahead, deploy it.',
      coaching: '',
    }),
  });
  assert.equal(d.action, 'block');
  assert.match(d.action === 'block' ? d.message : '', /A person answered/);
  assert.match(d.action === 'block' ? d.message : '', /Go ahead, deploy it/);
});

test('triage sending the agent back to self-serve also continues it', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig({ hitlKey: 'k' }), {
    judge: verdictFrom(BLOCKED),
    escalate: async () => ({
      outcome: 'self_serve',
      requestId: 'req_2',
      answer: '',
      coaching: 'The deploy key is already in .env.local. Use it.',
    }),
  });
  assert.equal(d.action, 'block');
  assert.match(d.action === 'block' ? d.message : '', /\.env\.local/);
});

test('nobody answering in time lets the agent stop rather than spinning', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig({ hitlKey: 'k' }), {
    judge: verdictFrom(BLOCKED),
    escalate: async () => ({ outcome: 'pending', requestId: 'req_3', answer: '', coaching: '' }),
  });
  assert.equal(d.action, 'allow');
  assert.match(d.why, /req_3/);
});

test('the service being down changes nothing', async () => {
  const d = await decide(payload(suspiciousTranscript()), testConfig({ hitlKey: 'k' }), {
    judge: verdictFrom(BLOCKED),
    escalate: async () => null,
  });
  assert.equal(d.action, 'allow');
});
