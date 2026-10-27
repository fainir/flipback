// Unit tests for the hook's pieces. Hermetic: the judge is a stub, nothing reaches a model.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { conversation, suspicious, PROMPT, judge, nudge, decide } from '../hooks/flipback.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const stubBin = path.join(here, 'fixtures', 'bin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flipback-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** Write rows (objects, or raw strings for broken lines) as a JSONL transcript. */
function transcript(rows) {
  const file = path.join(tmp, `t${n++}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const said = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const used = (name) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: name, name, input: {} }] } });
const result = (isError = false, extra = {}) =>
  user([{ type: 'tool_result', tool_use_id: 'x', content: isError ? 'boom' : 'ok', is_error: isError }], extra);

const LONG = 'This final message is long enough to be worth judging at all.';

describe('conversation', () => {
  test('reads the request, the final text and the tools of a real-shaped transcript', () => {
    const c = conversation(fixture('incomplete.jsonl'));
    assert.match(c.request, /^Add a slugify\(\) helper/);
    assert.match(c.last, /Let me now write the tests and update the README\.$/);
    assert.deepEqual(c.tools, ['Read', 'Edit']);
    assert.equal(c.failed, false);
  });

  test('strips system reminders from the request and ignores thinking blocks', () => {
    const c = conversation(fixture('complete.jsonl'));
    assert.equal(c.request, 'Add a slugify() helper to src/text.ts, write tests for it, and update the README with an example.');
    assert.deepEqual(c.tools, ['Edit', 'Write', 'Bash', 'Edit', 'Bash', 'Edit']);
  });

  test('a failed tool call is seen (it used to be dropped by the user-row branch)', () => {
    const c = conversation(transcript([user('Run the tests and fix them.'), used('Bash'), result(true), said(LONG)]));
    assert.equal(c.failed, true);
  });

  test('a failure followed by a successful call is not a failure', () => {
    const c = conversation(transcript([user('Fix it.'), used('Bash'), result(true), used('Bash'), result(false), said(LONG)]));
    assert.equal(c.failed, false);
  });

  test('a new request resets the text, the tools and the failure', () => {
    const c = conversation(transcript([user('First.'), used('Bash'), result(true), said('first answer'), user('Second.')]));
    assert.deepEqual(c, { request: 'Second.', last: '', tools: [], failed: false });
  });

  test('skips malformed lines, partial lines, blank lines and non-object JSON', () => {
    const c = conversation(transcript(['{"type":"user","message"', '', 'null', '42', '"text"', '[1,2]',
      user('The real request.'), 'not json at all', said(LONG), '{"type":"assistant","message":{"role":"assi']));
    assert.equal(c.request, 'The real request.');
    assert.equal(c.last, LONG);
  });

  test('copies of the request in api-request-blob rows are not the conversation', () => {
    const blob = (role, content) => ({ type: 'api-request-blob', sessionId: 's', hash: 'h', message: { role, content } });
    const c = conversation(transcript([user('Ship the parser.'), used('Bash'), result(), said(LONG),
      blob('user', [{ type: 'text', text: 'This session is being continued from a previous conversation.' }]),
      blob('assistant', [{ type: 'text', text: 'A copy of an older reply.' }])]));
    assert.equal(c.request, 'Ship the parser.');
    assert.equal(c.last, LONG);
    assert.deepEqual(c.tools, ['Bash']);
  });

  test('meta rows, compact summaries, sidechains and harness messages are not a person talking', () => {
    const c = conversation(transcript([
      user('Migrate the config loader.'),
      user('Stop hook feedback: keep going', { isMeta: true }),
      user('This session is being continued from a previous conversation...', { isCompactSummary: true }),
      user('Explore the repo and report.', { isSidechain: true }),
      user('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'),
      user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      said(LONG),
    ]));
    assert.equal(c.request, 'Migrate the config loader.');
  });

  test('accepts plain {role, content} rows and string assistant content', () => {
    const c = conversation(transcript([{ role: 'user', content: 'Plain request.' }, { role: 'assistant', content: LONG }]));
    assert.equal(c.request, 'Plain request.');
    assert.equal(c.last, LONG);
  });

  test('tolerates odd block shapes without throwing', () => {
    const c = conversation(transcript([user([null, { type: 'text', text: 42 }, { type: 'text', text: 'Real.' }]),
      { type: 'assistant', message: { role: 'assistant', content: [null, { type: 'text' }, { type: 'tool_use' }, { type: 'text', text: LONG }] } }]));
    assert.equal(c.request, 'Real.');
    assert.equal(c.last, LONG);
    assert.deepEqual(c.tools, []);
  });

  test('reads only the tail of a huge transcript, dropping the cut-off first line', () => {
    const filler = said('x'.repeat(5_000));
    const file = transcript([user('An old request that falls outside the window.'),
      ...Array.from({ length: 50 }, () => filler), user('The recent request.'), said(LONG)]);
    assert.ok(fs.statSync(file).size > 200_000);
    const c = conversation(file, 100_000);
    assert.equal(c.request, 'The recent request.');
  });

  test('a request that falls outside the window leaves request empty', () => {
    const file = transcript([user('The only request.'), ...Array.from({ length: 50 }, () => said('y'.repeat(5_000)))]);
    assert.equal(conversation(file, 100_000).request, '');
  });

  test('an empty transcript is an empty conversation', () => {
    assert.deepEqual(conversation(transcript([])), { request: '', last: '', tools: [], failed: false });
  });

  test('a missing file or path throws, for decide() to turn into "let it stop"', () => {
    assert.throws(() => conversation(path.join(tmp, 'nope.jsonl')), /ENOENT/);
    assert.throws(() => conversation(undefined), /transcript_path/);
  });
});

describe('suspicious', () => {
  const turn = (last, extra = {}) => ({ request: 'Do the thing.', last, tools: ['Bash'], failed: false, ...extra });

  test('a clean summary is not suspicious', () => {
    assert.equal(suspicious(turn('Done: added the flag, ran the suite, 40 passing.')), false);
  });

  for (const last of [
    'Added the helper. Let me now run the tests.',
    "Next, I'll update the README.",
    'Would you like me to continue with the frontend?',
    'The parser is done; error recovery is not yet implemented.',
    'Remaining:\n- [ ] wire up the CLI',
    'The frontend felt out of scope for this change.',
  ]) {
    test(`catches: ${JSON.stringify(last.slice(0, 40))}`, () => assert.equal(suspicious(turn(last)), true));
  }

  test('a failed last tool call is suspicious', () => {
    assert.equal(suspicious(turn('Reported the error.', { failed: true })), true);
  });

  test('edits that were never run are suspicious', () => {
    assert.equal(suspicious(turn('Changed the config.', { tools: ['Read', 'Edit'] })), true);
    assert.equal(suspicious(turn('Changed the config.', { tools: ['Edit', 'Bash'] })), false);
  });

  for (const request of ['stop', 'Ok, stop here.', 'please stop now', "That's enough for today", 'good enough, leave it']) {
    test(`the user said stop: ${JSON.stringify(request)}`, () => {
      assert.equal(suspicious(turn('Let me now run the tests.', { request })), false);
    });
  }

  for (const request of ['Fix the Stop hook so it reads the transcript', 'why did you stop?', "don't stop", 'Make the stop button work']) {
    test(`"stop" as a word is not a stop: ${JSON.stringify(request)}`, () => {
      assert.equal(suspicious(turn('Let me now run the tests.', { request })), true);
    });
  }
});

describe('PROMPT', () => {
  test('carries the request, the tools, the failure flag and the final message', () => {
    const p = PROMPT({ request: 'Build it.', last: 'Built half.', tools: ['Edit', 'Bash'], failed: true });
    assert.match(p, /USER ASKED:\nBuild it\./);
    assert.match(p, /TOOLS IT USED: Edit, Bash {2}\[a tool call FAILED\]/);
    assert.match(p, /ITS FINAL MESSAGE:\nBuilt half\./);
    assert.match(p, /Reply with only this JSON/);
  });

  test('bounds what it sends', () => {
    const p = PROMPT({ request: 'r'.repeat(10_000), last: 'l'.repeat(10_000), tools: [], failed: false });
    assert.ok(p.length < 13_000);
    assert.match(p, /TOOLS IT USED: \(none\)/);
  });
});

describe('nudge', () => {
  test('lets the agent stop unless the verdict is a clear "incomplete" with a message', () => {
    for (const v of [null, undefined, 42, [], {}, { complete: true, message: 'x' }, { complete: 'false', message: 'x' },
      { complete: false }, { complete: false, message: '   ' }, { complete: false, message: 7 }]) {
      assert.equal(nudge(v), null, JSON.stringify(v));
    }
  });

  test('passes the message on, with an escape hatch for the agent', () => {
    const out = nudge({ complete: false, message: 'Write the tests for slugify().' });
    assert.match(out, /^Write the tests for slugify\(\)\.\n\n/);
    assert.match(out, /say which in one line and end your turn\.\n$/);
  });

  test('replaces dashes and shouting, but not "!" inside code', () => {
    const out = nudge({ complete: false, message: 'Run it now! Then fix `a !== b` and `if (!ok)`\u2014the rest\u2013too!!' });
    assert.match(out, /^Run it now\. Then fix `a !== b` and `if \(!ok\)` - the rest - too\.\n/);
    assert.doesNotMatch(out, /[\u2013\u2014]/);
  });
});

describe('decide', () => {
  const base = { hook_event_name: 'Stop', transcript_path: fixture('incomplete.jsonl') };
  const env = {};
  const verdict = { complete: false, message: 'Write the tests for slugify(), then add the README example.' };
  const spy = (reply = verdict) => {
    const calls = [];
    const ask = async (prompt, e) => { calls.push({ prompt, env: e }); return reply; };
    return { calls, ask };
  };

  test('an unfinished turn is judged and blocked with the judge message', async () => {
    const { calls, ask } = spy();
    const out = await decide(base, { env, ask });
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Add a slugify\(\) helper/);
    assert.match(out, /^Write the tests for slugify\(\)/);
  });

  test('a finished turn never reaches the judge', async () => {
    const { calls, ask } = spy();
    assert.equal(await decide({ ...base, transcript_path: fixture('complete.jsonl') }, { env, ask }), null);
    assert.equal(calls.length, 0);
  });

  test('the judge saying "complete" lets it stop', async () => {
    const { ask } = spy({ complete: true, message: '' });
    assert.equal(await decide(base, { env, ask }), null);
  });

  test('the judge failing lets it stop', async () => {
    const { ask } = spy(null);
    assert.equal(await decide(base, { env, ask }), null);
  });

  test('one nudge per turn: stop_hook_active always lets it stop', async () => {
    const { calls, ask } = spy();
    assert.equal(await decide({ ...base, stop_hook_active: true }, { env, ask }), null);
    assert.equal(calls.length, 0);
  });

  test('FLIPBACK_DISABLED and FLIPBACK_OFF turn it off', async () => {
    const { calls, ask } = spy();
    assert.equal(await decide(base, { env: { FLIPBACK_DISABLED: '1' }, ask }), null);
    assert.equal(await decide(base, { env: { FLIPBACK_OFF: '1' }, ask }), null);
    assert.equal(calls.length, 0);
  });

  test('a missing, unreadable or absent transcript lets it stop', async () => {
    const { calls, ask } = spy();
    for (const input of [{ ...base, transcript_path: path.join(tmp, 'missing.jsonl') }, { ...base, transcript_path: tmp },
      { hook_event_name: 'Stop' }, null, 'nonsense', 42]) {
      assert.equal(await decide(input, { env, ask }), null, JSON.stringify(input));
    }
    assert.equal(calls.length, 0);
  });

  test('prefers last_assistant_message, because the transcript can lag at Stop time', async () => {
    const { calls, ask } = spy({ complete: true, message: '' });
    const done = 'Added slugify(), its tests (6 passing) and the README example. Everything you asked for is in.';
    assert.equal(await decide({ ...base, last_assistant_message: done }, { env, ask }), null);
    assert.equal(calls.length, 1, 'edits without Bash are still suspicious, so the judge runs');
    assert.match(calls[0].prompt, /ITS FINAL MESSAGE:\nAdded slugify\(\), its tests/);
  });

  test('a short final message with no failure is not judged', async () => {
    const { calls, ask } = spy();
    const file = transcript([user('Rename foo to bar.'), used('Edit'), result(), said('Done.')]);
    assert.equal(await decide({ ...base, transcript_path: file }, { env, ask }), null);
    assert.equal(calls.length, 0);
  });

  test('a short final message after a failure is judged', async () => {
    const { calls, ask } = spy();
    const file = transcript([user('Deploy the docs.'), used('Bash'), result(true), said('It failed.')]);
    assert.ok(await decide({ ...base, transcript_path: file }, { env, ask }));
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /\[a tool call FAILED\]/);
  });

  test('stays quiet while a subagent or a scheduled wakeup will bring the agent back', async () => {
    const { calls, ask } = spy();
    const agent = { id: 't1', type: 'subagent', status: 'running', description: 'review' };
    const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' };
    assert.equal(await decide({ ...base, background_tasks: [agent], session_crons: [] }, { env, ask }), null);
    assert.equal(await decide({ ...base, background_tasks: [], session_crons: [cron] }, { env, ask }), null);
    assert.equal(calls.length, 0);
  });

  test('a background shell (a dev server, say) does not silence it', async () => {
    const { calls, ask } = spy();
    const server = { id: 't2', type: 'shell', status: 'running', command: 'npm run dev' };
    assert.ok(await decide({ ...base, background_tasks: [server], session_crons: [] }, { env, ask }));
    assert.equal(calls.length, 1);
  });
});

describe('judge (with a stub claude on PATH)', () => {
  const stubEnv = (extra = {}) => ({ PATH: `${stubBin}${path.delimiter}${process.env.PATH}`, ...extra });

  test('runs claude -p as a bare judge and parses its JSON verdict', async () => {
    const log = path.join(tmp, 'judge-args.json');
    const v = await judge('the prompt', stubEnv({
      FAKE_CLAUDE_LOG: log,
      FAKE_CLAUDE_REPLY: 'Sure.\n```json\n{"complete": false, "message": "Run the tests."}\n```\n',
    }));
    assert.deepEqual(v, { complete: false, message: 'Run the tests.' });
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(seen.prompt, 'the prompt');
    assert.equal(seen.flipbackOff, '1', 'the judge must not fire flipback again');
    assert.deepEqual(seen.args, ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--settings', '{"disableAllHooks":true}']);
  });

  test('FLIPBACK_MODEL picks the model, and an empty one falls back to haiku', async () => {
    const log = path.join(tmp, 'judge-model.json');
    await judge('p', stubEnv({ FAKE_CLAUDE_LOG: log, FLIPBACK_MODEL: 'sonnet' }));
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).args[2], 'sonnet');
    await judge('p', stubEnv({ FAKE_CLAUDE_LOG: log, FLIPBACK_MODEL: '' }));
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).args[2], 'haiku');
  });

  test('a judge that hangs is killed at FLIPBACK_TIMEOUT_MS and counts as no verdict', async () => {
    const started = Date.now();
    assert.equal(await judge('p', stubEnv({ FAKE_CLAUDE_SLEEP: '10000', FLIPBACK_TIMEOUT_MS: '300' })), null);
    assert.ok(Date.now() - started < 5_000);
  });

  test('a junk FLIPBACK_TIMEOUT_MS falls back to the default instead of firing at once', async () => {
    const v = await judge('p', stubEnv({ FAKE_CLAUDE_SLEEP: '200', FLIPBACK_TIMEOUT_MS: 'soon',
      FAKE_CLAUDE_REPLY: '{"complete": false, "message": "m"}' }));
    assert.deepEqual(v, { complete: false, message: 'm' });
  });

  test('no claude on PATH, garbage output, or a non-zero exit is no verdict', async () => {
    assert.equal(await judge('p', { PATH: tmp }), null);
    assert.equal(await judge('p', stubEnv({ FAKE_CLAUDE_REPLY: 'I think it is fine.' })), null);
    assert.equal(await judge('p', stubEnv({ FAKE_CLAUDE_REPLY: '{"complete": false, message: oops}' })), null);
    assert.equal(await judge('p', stubEnv({ FAKE_CLAUDE_REPLY: '{"complete": false, "message": "m"}', FAKE_CLAUDE_EXIT: '1' })), null);
  });
});
