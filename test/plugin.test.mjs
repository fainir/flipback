// The plugin as Claude Code sees it: the manifests, and the Stop hook run end to end through the
// exact command in hooks/hooks.json. The judge is a stub `claude` first on PATH; no model is called.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const json = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const fixture = (name) => path.join(here, 'fixtures', name);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flipback-e2e-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const hooks = json('hooks/hooks.json');
const stop = hooks.hooks.Stop[0].hooks[0];

/** Run the Stop hook the way Claude Code does: the shell-form command, JSON on stdin. */
function runHook(input, env = {}) {
  const res = spawnSync('/bin/sh', ['-c', stop.command], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${path.join(here, 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}`,
      HOME: tmp,
      CLAUDE_PLUGIN_ROOT: root,
      ...env,
    },
  });
  return { code: res.status, stderr: res.stderr, stdout: res.stdout };
}

const stopInput = (transcript, extra = {}) => ({
  session_id: 'test', transcript_path: fixture(transcript), cwd: '/work/demo',
  permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, ...extra,
});
const INCOMPLETE = JSON.stringify({
  complete: false,
  message: 'The request had three parts and you did one. Write the tests for slugify(), then add the README example.',
});

describe('manifests', () => {
  test('hooks.json registers one Stop command hook', () => {
    assert.deepEqual(Object.keys(hooks.hooks), ['Stop']);
    assert.equal(stop.type, 'command');
  });

  test('the Stop command points at a script that exists in the plugin', () => {
    const m = stop.command.match(/"\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/);
    assert.ok(m, `expected a quoted \${CLAUDE_PLUGIN_ROOT} path in: ${stop.command}`);
    assert.ok(fs.existsSync(path.join(root, m[1])), `${m[1]} does not exist`);
  });

  test('the hook timeout outlasts the judge timeout, so the judge always gives up first', () => {
    assert.ok(stop.timeout * 1000 > 90_000);
  });

  test('plugin.json and the marketplace entry agree', () => {
    const plugin = json('.claude-plugin/plugin.json');
    const market = json('.claude-plugin/marketplace.json');
    const entry = market.plugins.find((p) => p.name === plugin.name);
    assert.ok(entry, 'marketplace lists the plugin under its own name');
    assert.equal(entry.source, './');
    assert.equal(entry.version, plugin.version);
    assert.equal(market.metadata.version, plugin.version);
    assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
    assert.equal(plugin.license, 'MIT');
    assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /^MIT License/);
  });

  test('the skill has frontmatter whose name matches its folder', () => {
    const skill = fs.readFileSync(path.join(root, 'skills/flipback/SKILL.md'), 'utf8');
    const front = skill.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, 'SKILL.md starts with YAML frontmatter');
    assert.match(front[1], /^name: flipback$/m);
    assert.match(front[1], /^description: .{50,}$/m);
  });
});

describe('the Stop hook, end to end', () => {
  test('an unfinished turn exits 2 and hands the judge message back on stderr', () => {
    const log = path.join(tmp, 'incomplete.json');
    const r = runHook(stopInput('incomplete.jsonl'), { FAKE_CLAUDE_REPLY: INCOMPLETE, FAKE_CLAUDE_LOG: log });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /^The request had three parts and you did one\. Write the tests for slugify\(\)/);
    assert.match(r.stderr, /say which in one line and end your turn\.\n$/);
    assert.equal(r.stdout, '');
    const seen = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.match(seen.prompt, /USER ASKED:\nAdd a slugify\(\) helper/);
    assert.match(seen.prompt, /TOOLS IT USED: Read, Edit\n/);
  });

  test('a finished turn exits 0 without ever calling the judge', () => {
    const log = path.join(tmp, 'complete.json');
    const r = runHook(stopInput('complete.jsonl'), { FAKE_CLAUDE_REPLY: INCOMPLETE, FAKE_CLAUDE_LOG: log });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.equal(fs.existsSync(log), false);
  });

  test('the judge calling it complete exits 0', () => {
    const r = runHook(stopInput('incomplete.jsonl'), { FAKE_CLAUDE_REPLY: '{"complete": true, "message": ""}' });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  test('stop_hook_active exits 0: it never fires twice in a row', () => {
    const r = runHook(stopInput('incomplete.jsonl', { stop_hook_active: true }), { FAKE_CLAUDE_REPLY: INCOMPLETE });
    assert.equal(r.code, 0);
  });

  test('FLIPBACK_DISABLED=1 exits 0', () => {
    const r = runHook(stopInput('incomplete.jsonl'), { FAKE_CLAUDE_REPLY: INCOMPLETE, FLIPBACK_DISABLED: '1' });
    assert.equal(r.code, 0);
  });

  test('a judge that hangs past FLIPBACK_TIMEOUT_MS exits 0', () => {
    const started = Date.now();
    const r = runHook(stopInput('incomplete.jsonl'),
      { FAKE_CLAUDE_REPLY: INCOMPLETE, FAKE_CLAUDE_SLEEP: '15000', FLIPBACK_TIMEOUT_MS: '300' });
    assert.equal(r.code, 0);
    assert.ok(Date.now() - started < 10_000);
  });

  test('no claude on PATH exits 0', () => {
    const r = runHook(stopInput('incomplete.jsonl'), { PATH: path.dirname(process.execPath) });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  for (const [name, input] of [['empty stdin', ''], ['invalid JSON', '{"transcript_path": '],
    ['a missing transcript', { ...stopInput('incomplete.jsonl'), transcript_path: path.join(tmp, 'gone.jsonl') }],
    ['no transcript_path', { hook_event_name: 'Stop' }]]) {
    test(`${name} exits 0`, () => {
      const r = runHook(input, { FAKE_CLAUDE_REPLY: INCOMPLETE });
      assert.equal(r.code, 0);
      assert.equal(r.stderr, '');
    });
  }
});
