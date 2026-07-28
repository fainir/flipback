import os from 'node:os';
import path from 'node:path';

export type Mode = 'signals' | 'always' | 'heuristic' | 'off';

export interface Config {
  /** `signals` runs the judge only on a suspicious turn; `always` judges every turn. */
  mode: Mode;
  /** Consecutive nudges allowed per user turn before flipback lets the agent stop. */
  maxContinues: number;
  /** Model for the judge. A small fast one is correct here: this is a classification. */
  model: string;
  /** Hard cap on the judge subprocess. Must stay under the hook timeout in settings.json. */
  timeoutMs: number;
  /** Turns shorter than this are not judged, unless a signal fired or a tool call failed. */
  minTurnChars: number;
  /** Which `claude` to spawn. Resolved from PATH unless overridden. */
  claudeBin: string;
  stateDir: string;
  /** Optional: route a genuinely blocked agent to a real person instead of nudging it. */
  hitlUrl: string;
  hitlKey: string;
  hitlWaitSeconds: number;
  debug: boolean;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function mode(value: string | undefined): Mode {
  switch ((value ?? '').toLowerCase()) {
    case 'always':
      return 'always';
    case 'heuristic':
      return 'heuristic';
    case 'off':
      return 'off';
    default:
      return 'signals';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // One switch that turns the whole thing off without uninstalling it. People need this.
  const disabled = env.FLIPBACK_DISABLED === '1' || env.FLIPBACK_DISABLED === 'true';

  return {
    mode: disabled ? 'off' : mode(env.FLIPBACK_MODE),
    maxContinues: num(env.FLIPBACK_MAX_CONTINUES, 3),
    model: env.FLIPBACK_MODEL ?? 'haiku',
    timeoutMs: num(env.FLIPBACK_TIMEOUT_MS, 45_000),
    minTurnChars: num(env.FLIPBACK_MIN_CHARS, 40),
    claudeBin: env.FLIPBACK_CLAUDE_BIN ?? 'claude',
    stateDir: env.FLIPBACK_STATE_DIR ?? path.join(os.homedir(), '.flipback'),
    hitlUrl: (env.HITL_URL ?? 'http://localhost:4177').replace(/\/+$/, ''),
    hitlKey: env.HITL_API_KEY ?? env.HITL_TOKEN ?? '',
    // Long enough for someone to actually answer, short enough that the judge's budget plus this
    // stays under the 120s hook timeout that `flipback install` writes.
    hitlWaitSeconds: num(env.FLIPBACK_HITL_WAIT_SECONDS, 45),
    debug: env.FLIPBACK_DEBUG === '1' || env.FLIPBACK_DEBUG === 'true',
  };
}

/**
 * True when this process is running inside flipback's own judge subprocess.
 *
 * The judge is `claude -p`, which fires Stop hooks of its own. Without this check the first
 * nudge would spawn a judge, whose stop would spawn a judge, forever.
 */
export function insideJudge(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FLIPBACK_JUDGE === '1';
}
