import { insideJudge, type Config } from './config.js';
import { prefilter, type Prefilter } from './heuristics.js';
import { judge as runJudge, type JudgeOutcome, type Verdict } from './judge.js';
import { buildJudgePrompt } from './prompt.js';
import { escalate as runEscalate, shouldEscalate, type HumanOutcome } from './hitl.js';
import { continuesSpent, recordContinue } from './state.js';
import { readSlice, str, type Slice } from './transcript.js';

/**
 * The whole decision, with no process exits and no I/O of its own.
 *
 * Every path through this function is a test case, which is the point of separating it from the
 * hook shell. The shell only translates a Decision into an exit code.
 */

export type Decision =
  | { action: 'allow'; why: string; detail?: Detail }
  | { action: 'block'; message: string; nudge: number; why: string; detail?: Detail };

export interface Detail {
  signals?: string[];
  score?: number;
  verdict?: Verdict | null;
  judgeError?: string;
  judgeMs?: number;
  human?: HumanOutcome | null;
}

export interface Deps {
  readSlice: (path: string) => Slice;
  judge: (prompt: string, config: Config) => Promise<JudgeOutcome>;
  escalate: typeof runEscalate;
  continuesSpent: typeof continuesSpent;
  recordContinue: typeof recordContinue;
  env: NodeJS.ProcessEnv;
}

export const defaultDeps: Deps = {
  readSlice: (path) => readSlice(path),
  judge: runJudge,
  escalate: runEscalate,
  continuesSpent,
  recordContinue,
  env: process.env,
};

const allow = (why: string, detail?: Detail): Decision => ({ action: 'allow', why, detail });

export async function decide(
  payload: Record<string, unknown>,
  config: Config,
  overrides: Partial<Deps> = {},
): Promise<Decision> {
  const deps: Deps = { ...defaultDeps, ...overrides };

  // ---- guards --------------------------------------------------------------
  // Ordered cheapest-first, and every one of them is a reason flipback must stay silent.

  if (insideJudge(deps.env)) return allow('running inside flipback\'s own judge');
  if (config.mode === 'off') return allow('disabled by configuration');

  const transcriptPath = str(payload, 'transcript_path');
  if (!transcriptPath) return allow('no transcript path in the hook payload');

  const slice = deps.readSlice(transcriptPath);
  if (!slice.userRequest && !slice.lastAssistantText && slice.toolCalls.length === 0) {
    return allow('nothing readable in the transcript');
  }

  const sessionId = str(payload, 'session_id') || 'unknown';
  const stopHookActive = payload.stop_hook_active === true;
  const spent = deps.continuesSpent(config.stateDir, sessionId, slice.userMessageCount);

  if (spent >= config.maxContinues) {
    return allow(`nudge budget spent (${spent}/${config.maxContinues})`);
  }
  // Claude Code says we already blocked once, but our counter disagrees. That means state is not
  // persisting, so the counter cannot bound anything - fall back to one nudge per turn.
  if (stopHookActive && spent === 0) {
    return allow('continuing from a previous hook and the nudge counter is unavailable');
  }

  // ---- prefilter -----------------------------------------------------------
  // Free, so it runs before the length guard rather than after: some of the worst early stops
  // are also the shortest ("Should I continue?"), and a length check in front of the signals
  // would wave through exactly those.

  const pre: Prefilter = prefilter(slice);
  const detail: Detail = { signals: pre.signals.map((s) => s.id), score: pre.score };

  const endedOnFailure = slice.toolCalls[slice.toolCalls.length - 1]?.failed === true;
  if (slice.lastAssistantText.length < config.minTurnChars && !pre.suspicious && !endedOnFailure) {
    return allow('turn too short to be worth checking', detail);
  }

  if (config.mode !== 'always' && !pre.suspicious) {
    return allow('no completion signals in this turn', detail);
  }

  if (config.mode === 'heuristic') {
    // No judge available or wanted. Pattern matches alone are thin evidence, so this mode says
    // exactly what it saw and lets the agent be the judge of it.
    const nudge = deps.recordContinue(config.stateDir, sessionId, slice.userMessageCount);
    return {
      action: 'block',
      nudge,
      why: 'heuristic mode, signals fired',
      message: heuristicMessage(pre, nudge, config.maxContinues),
      detail,
    };
  }

  // ---- judge ---------------------------------------------------------------

  const outcome = await deps.judge(buildJudgePrompt(slice, pre.signals), config);
  detail.judgeMs = outcome.durationMs;
  detail.judgeError = outcome.error;
  detail.verdict = outcome.verdict;

  // A judge that could not run is not evidence of anything. Never block on it.
  if (!outcome.verdict) return allow(outcome.error ?? 'judge produced no verdict', detail);

  const verdict = outcome.verdict;

  if (verdict.complete) {
    if (shouldEscalate(config, verdict)) {
      const human = await deps.escalate(config, verdict, {
        sessionId,
        cwd: str(payload, 'cwd'),
        userRequest: slice.userRequest,
      });
      detail.human = human;

      // A person answered while we waited. That is new information the agent can act on, so it
      // is worth continuing for - unlike a bare nudge, this actually unblocks it.
      if (human?.outcome === 'answered' && human.answer) {
        const nudge = deps.recordContinue(config.stateDir, sessionId, slice.userMessageCount);
        return {
          action: 'block',
          nudge,
          why: 'a human answered the thing that was blocking the agent',
          message: humanAnsweredMessage(human.answer),
          detail,
        };
      }
      if (human?.outcome === 'self_serve' && human.coaching) {
        const nudge = deps.recordContinue(config.stateDir, sessionId, slice.userMessageCount);
        return {
          action: 'block',
          nudge,
          why: 'triage decided the agent can handle this itself',
          message: humanCoachingMessage(human.coaching),
          detail,
        };
      }
      return allow(`blocked on a person (request ${human?.requestId || 'not created'})`, detail);
    }
    return allow(verdict.reason || 'the judge found the work complete', detail);
  }

  // An unsure judge should not be the thing that forces more work.
  if (verdict.confidence < 0.4) {
    return allow(`judge was unsure (confidence ${verdict.confidence.toFixed(2)})`, detail);
  }
  if (!verdict.message.trim()) {
    return allow('judge found it incomplete but wrote no message', detail);
  }

  const nudge = deps.recordContinue(config.stateDir, sessionId, slice.userMessageCount);
  return {
    action: 'block',
    nudge,
    why: verdict.reason || 'work outstanding',
    message: nudgeMessage(verdict.message, nudge, config.maxContinues),
    detail,
  };
}

// ---------------------------------------------------------------------------
// Message assembly
//
// The judge writes the body. Everything here is the frame around it: who is speaking, how much
// budget is left, and how the agent disagrees if we got it wrong.
// ---------------------------------------------------------------------------

function header(nudge: number, max: number): string {
  return nudge >= max ? `[flipback ${nudge}/${max}, last one]` : `[flipback ${nudge}/${max}]`;
}

const DISAGREE =
  'If this is wrong - the work really is done, or you need authority, a secret, or a decision ' +
  'only a person can make - say which in one line and end your turn.';

function nudgeMessage(body: string, nudge: number, max: number): string {
  return `${header(nudge, max)}\n\n${body}\n\n${DISAGREE}\n`;
}

function humanAnsweredMessage(answer: string): string {
  return [
    '[flipback] A person answered the thing you were blocked on:',
    '',
    answer,
    '',
    'Act on that and continue.',
    '',
  ].join('\n');
}

function humanCoachingMessage(coaching: string): string {
  return [
    '[flipback] This does not need a person. Triage sent back:',
    '',
    coaching,
    '',
    'Do that, then continue.',
    '',
  ].join('\n');
}

function heuristicMessage(pre: Prefilter, nudge: number, max: number): string {
  const points = pre.signals
    .filter((s) => s.weight > 0)
    .map((s) => `- ${s.detail}`)
    .join('\n');
  return [
    header(nudge, max),
    '',
    'Your turn looks unfinished:',
    '',
    points,
    '',
    'You have the tools, the files and the request itself as authorisation. Deal with the ' +
      'specific item above, then continue.',
    '',
    DISAGREE,
    '',
  ].join('\n');
}
