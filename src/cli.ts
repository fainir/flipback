#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { decide, type Decision } from './decide.js';
import { readHookInput, readSlice, str } from './transcript.js';
import { prefilter } from './heuristics.js';
import { logDecision, readLog } from './log.js';
import { prune } from './state.js';
import {
  hookCommand,
  install,
  isInstalled,
  packageRoot,
  uninstall,
  claudeDir,
} from './install.js';

const out = (text: string) => process.stdout.write(`${text}\n`);

// ---------------------------------------------------------------------------
// stop - the hook itself
// ---------------------------------------------------------------------------

/**
 * Exit 2 is how a Stop hook refuses the stop: stderr goes back to the model and the turn resumes.
 * Exit 0 is "carry on stopping". There is no third option, and any unexpected state must resolve
 * to 0 - an agent held hostage by a broken hook is a worse outcome than every early stop combined.
 */
async function stopCommand(): Promise<never> {
  let config: Config;
  let sessionId = 'unknown';

  try {
    config = loadConfig();
    const payload = await readHookInput();
    sessionId = str(payload, 'session_id') || 'unknown';

    const decision = await decide(payload, config);
    logDecision(config, sessionId, decision);
    // Cheap enough to do inline, and it keeps ~/.flipback from growing without bound.
    if (Math.random() < 0.02) prune(config.stateDir);

    if (decision.action === 'block') {
      process.stderr.write(decision.message);
      process.exit(2);
    }
    if (config.debug) process.stderr.write(`[flipback] allow: ${decision.why}\n`);
  } catch (err) {
    if (process.env.FLIPBACK_DEBUG === '1') {
      process.stderr.write(`[flipback] error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// check - run the same decision against a transcript, without acting on it
// ---------------------------------------------------------------------------

async function checkCommand(args: string[]): Promise<never> {
  const config = loadConfig();
  const target = args.find((a) => !a.startsWith('-'));
  const transcriptPath = target ?? latestTranscript();

  if (!transcriptPath) {
    out('No transcript given and none found under ~/.claude/projects.');
    out('Usage: flipback check <path-to-transcript.jsonl>');
    process.exit(1);
  }
  if (!fs.existsSync(transcriptPath)) {
    out(`No such transcript: ${transcriptPath}`);
    process.exit(1);
  }

  out(`transcript  ${transcriptPath}`);
  const slice = readSlice(transcriptPath);
  out(`request     ${oneLine(slice.userRequest, 90) || '(none found)'}`);
  out(`tools       ${slice.toolCalls.length} calls, ${slice.toolCalls.filter((c) => c.failed).length} failed`);

  const pre = prefilter(slice);
  out(`signals     ${pre.signals.map((s) => s.id).join(', ') || '(none)'}  score=${pre.score}`);
  out('');

  const decision = await decide(
    { transcript_path: transcriptPath, session_id: 'flipback-check', stop_hook_active: false },
    config,
    // A dry run must not spend the real session's nudge budget.
    { continuesSpent: () => 0, recordContinue: () => 1 },
  );

  render(decision);
  process.exit(0);
}

function render(decision: Decision): void {
  if (decision.action === 'allow') {
    out(`ALLOW  ${decision.why}`);
    return;
  }
  out(`BLOCK  ${decision.why}`);
  out('');
  out(
    decision.message
      .split('\n')
      .map((l) => (l ? `  ${l}` : ''))
      .join('\n'),
  );
}

/** Most recently modified transcript across all projects, for a zero-argument `check`. */
function latestTranscript(): string | null {
  const root = path.join(process.env.HOME ?? '', '.claude', 'projects');
  let best: { file: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          const mtime = fs.statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { file: full, mtime };
        } catch {
          // Skip.
        }
      }
    }
  };
  walk(root, 0);
  return best ? (best as { file: string }).file : null;
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

function installCommand(args: string[]): never {
  const scope = args.includes('--global') || args.includes('-g') ? 'user' : 'project';
  const dir = args.find((a) => !a.startsWith('-')) ?? process.cwd();

  let result;
  try {
    result = install(scope, dir);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  out(`flipback installed (${scope === 'user' ? 'all projects' : dir})`);
  out('');
  out(`  hook   ${result.settingsPath}`);
  out(`  skill  ${result.skillPath || '(skill file not found in package)'}`);
  out('');
  out('Every turn that ends now gets checked. Most cost nothing: a local pattern check runs');
  out('first and only a suspicious turn is sent to the judge.');
  out('');
  out('  flipback check      see what it would decide about your last session');
  out('  flipback doctor     confirm the judge can actually run');
  out('  flipback log        what it has decided recently');
  out('');
  out('Turn it off without uninstalling:  export FLIPBACK_DISABLED=1');
  process.exit(0);
}

function uninstallCommand(args: string[]): never {
  const scope = args.includes('--global') || args.includes('-g') ? 'user' : 'project';
  const dir = args.find((a) => !a.startsWith('-')) ?? process.cwd();

  const result = uninstall(scope, dir);
  out(
    result.removedHooks > 0 || result.removedSkill
      ? `Removed flipback from ${result.settingsPath}`
      : `flipback was not installed in ${result.settingsPath}`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function doctorCommand(): Promise<never> {
  const config = loadConfig();
  const ok = (label: string, detail: string) => out(`  ok    ${label.padEnd(14)} ${detail}`);
  const bad = (label: string, detail: string) => out(`  FAIL  ${label.padEnd(14)} ${detail}`);
  const note = (label: string, detail: string) => out(`  -     ${label.padEnd(14)} ${detail}`);

  out('flipback doctor');
  out('');

  if (config.mode === 'off') bad('mode', 'disabled (FLIPBACK_DISABLED is set)');
  else ok('mode', config.mode);

  note('budget', `${config.maxContinues} nudges per user turn`);
  note('model', config.model);
  note('timeout', `${config.timeoutMs}ms`);

  isInstalled('project')
    ? ok('project hook', path.join(claudeDir('project', process.cwd()), 'settings.json'))
    : note('project hook', 'not installed here (flipback install)');
  isInstalled('user')
    ? ok('user hook', path.join(claudeDir('user', process.cwd()), 'settings.json'))
    : note('user hook', 'not installed (flipback install --global)');

  const skill = path.join(packageRoot(), 'skills', 'flipback', 'SKILL.md');
  fs.existsSync(skill) ? ok('skill', skill) : bad('skill', `missing at ${skill}`);

  out('');
  out('  ...   judge          probing');

  // The judge is the one component that can fail invisibly, so doctor exercises it for real
  // rather than checking that the binary exists.
  const { judge } = await import('./judge.js');
  const result = await judge(
    'Reply with exactly this JSON and nothing else: {"complete": true, "confidence": 1, ' +
      '"unfinished": [], "reason": "probe", "blocked": false, "blocked_kind": "none", "message": ""}',
    config,
  );
  // Move back over the "probing" line so the verdict replaces it.
  process.stdout.write('\u001b[1A\u001b[2K');
  if (result.verdict) ok('judge', `${config.claudeBin} responded in ${result.durationMs}ms`);
  else bad('judge', `${result.error ?? 'no verdict'} - flipback will allow every stop`);

  // The probe above is a two-line prompt. Real judging sends a whole conversation and takes
  // several times longer, so the probe passing says nothing about whether the budget is enough.
  // Recorded runs do, and a timeout is invisible in normal use: it just allows the stop.
  const history = readLog(config, 200);
  const timeouts = history.filter((r) => /timed out/.test(r.judgeError ?? '')).length;
  const seen = history.map((r) => r.judgeMs ?? 0).filter((ms) => ms > 50);
  if (seen.length) {
    const slowest = Math.max(...seen);
    const share = slowest / config.timeoutMs;
    const detail = `${seen.length} real runs, slowest ${(slowest / 1000).toFixed(1)}s of the ${(config.timeoutMs / 1000).toFixed(0)}s budget`;
    if (timeouts > 0) bad('judge budget', `${detail}, and ${timeouts} timed out - raise FLIPBACK_TIMEOUT_MS`);
    else if (share > 0.6) bad('judge budget', `${detail} - too close, raise FLIPBACK_TIMEOUT_MS`);
    else ok('judge budget', detail);
  } else {
    note('judge budget', `${(config.timeoutMs / 1000).toFixed(0)}s, no real runs recorded yet`);
  }

  out('');
  config.hitlKey
    ? ok('human escalation', config.hitlUrl)
    : note('human escalation', 'off (set HITL_API_KEY to route blocked agents to a person)');
  out('');
  process.exit(result.verdict ? 0 : 1);
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

function logCommand(args: string[]): never {
  const config = loadConfig();
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const records = readLog(config, limitArg ? Number(limitArg) : 20);
  if (records.length === 0) {
    out('Nothing logged yet.');
    process.exit(0);
  }
  for (const r of records) {
    const tag = r.action === 'block' ? `BLOCK ${r.nudge ?? ''}`.trim() : 'allow';
    out(`${r.at.slice(0, 19)}  ${tag.padEnd(8)} ${r.why}`);
    if (r.unfinished?.length) out(`${' '.repeat(21)}   ${r.unfinished.join('; ')}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function usage(): never {
  out(`flipback ${version()} - put the agent back on when it stops early

  flipback install [dir]      wire the hook and skill into a project
  flipback install --global   wire them in for every project
  flipback uninstall [dir]    remove them again
  flipback check [transcript] decide about a transcript without acting on it
  flipback doctor             confirm the judge can run
  flipback log [n]            recent decisions
  flipback stop               the hook entry point, reads a payload on stdin

Configuration, all optional:

  FLIPBACK_DISABLED=1         turn it off without uninstalling
  FLIPBACK_MODE=signals       signals (default) | always | heuristic | off
  FLIPBACK_MAX_CONTINUES=3    consecutive nudges allowed per user turn
  FLIPBACK_MODEL=haiku        model for the judge
  FLIPBACK_TIMEOUT_MS=45000   hard cap on the judge
  FLIPBACK_DEBUG=1            verbose, and log the full nudge text
  HITL_API_KEY=...            route genuinely blocked agents to a real person

  the hook command it installs:
  ${hookCommand()}`);
  process.exit(0);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'stop':
      await stopCommand();
      break;
    case 'check':
      await checkCommand(args);
      break;
    case 'install':
      installCommand(args);
      break;
    case 'uninstall':
      uninstallCommand(args);
      break;
    case 'doctor':
      await doctorCommand();
      break;
    case 'log':
      logCommand(args);
      break;
    case '--version':
    case '-v':
      out(version());
      process.exit(0);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  // Anything reaching here during `stop` would already have exited; for the other commands a
  // stack trace is more useful than silence.
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
