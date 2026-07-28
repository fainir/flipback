import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { install, isInstalled, uninstall } from '../src/install.js';
import { tempDir } from './helpers.js';

const settingsOf = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

test('install writes a Stop hook and reports where', () => {
  const dir = tempDir();
  const result = install('project', dir);
  assert.equal(result.settingsPath, path.join(dir, '.claude', 'settings.json'));
  assert.equal(settingsOf(dir).hooks.Stop.length, 1);
  assert.match(settingsOf(dir).hooks.Stop[0].hooks[0].command, /flipback|cli\.js/);
  assert.equal(isInstalled('project', dir), true);
});

test('install ships the skill alongside the hook', () => {
  const dir = tempDir();
  const result = install('project', dir);
  assert.ok(result.skillPath, 'the skill file must be found in the package');
  assert.ok(fs.existsSync(result.skillPath));
  assert.match(fs.readFileSync(result.skillPath, 'utf8'), /^---/);
});

test('installing twice leaves exactly one hook', () => {
  const dir = tempDir();
  install('project', dir);
  install('project', dir);
  install('project', dir);
  assert.equal(settingsOf(dir).hooks.Stop.length, 1);
});

test('other people\'s hooks and settings survive install and uninstall', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'some-other-tool stop' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
      },
    }),
  );

  install('project', dir);
  let settings = settingsOf(dir);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions.allow, ['Bash(npm test)']);
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.hooks.PreToolUse.length, 1);

  uninstall('project', dir);
  settings = settingsOf(dir);
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'some-other-tool stop');
  assert.equal(settings.hooks.PreToolUse.length, 1);
});

test('uninstall removes the Stop key entirely when nothing else is left', () => {
  const dir = tempDir();
  install('project', dir);
  uninstall('project', dir);
  const settings = settingsOf(dir);
  assert.equal(settings.hooks, undefined, 'no empty scaffolding should be left behind');
  assert.equal(isInstalled('project', dir), false);
});

test('uninstall removes the skill directory', () => {
  const dir = tempDir();
  const { skillPath } = install('project', dir);
  const result = uninstall('project', dir);
  assert.equal(result.removedSkill, true);
  assert.equal(fs.existsSync(skillPath), false);
});

test('uninstalling when never installed is not an error', () => {
  const dir = tempDir();
  const result = uninstall('project', dir);
  assert.equal(result.removedHooks, 0);
  assert.equal(result.removedSkill, false);
});

test('an unparseable settings file is refused, not overwritten', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const file = path.join(dir, '.claude', 'settings.json');
  fs.writeFileSync(file, '{ this is not json');

  assert.throws(() => install('project', dir), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json');
});

test('an empty settings file is treated as empty settings, not as corruption', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '\n');
  install('project', dir);
  assert.equal(settingsOf(dir).hooks.Stop.length, 1);
});
