import { spawn } from 'node:child_process';
import type { Config } from './config.js';

export type BlockedKind = 'authority' | 'credential' | 'ambiguity' | 'none';

export interface Verdict {
  complete: boolean;
  confidence: number;
  unfinished: string[];
  reason: string;
  blocked: boolean;
  blockedKind: BlockedKind;
  message: string;
}

export interface JudgeOutcome {
  verdict: Verdict | null;
  /** Why there is no verdict, for `flipback doctor` and debug output. */
  error?: string;
  durationMs: number;
}

/**
 * Runs the judge as a headless `claude -p` subprocess.
 *
 * Using the CLI rather than the API is deliberate: it means flipback works on a fresh machine
 * with no API key, on whatever auth the user already has for Claude Code. The cost is that the
 * child fires Stop hooks of its own, which is what `FLIPBACK_JUDGE=1` exists to cut off.
 */
export async function judge(prompt: string, config: Config): Promise<JudgeOutcome> {
  const started = Date.now();

  // Primary run asks for structured output. If this build of the CLI does not know a flag, the
  // fallback drops everything optional rather than giving up on the judge entirely.
  const attempts: string[][] = [
    ['-p', '--output-format', 'json', '--model', config.model],
    ['-p'],
  ];

  let lastError = 'judge did not run';

  for (const args of attempts) {
    // `timeoutMs` is a budget for the judge as a whole, not per attempt. Two full-length
    // attempts would blow past the hook timeout and get us killed mid-write.
    const remaining = config.timeoutMs - (Date.now() - started);
    if (remaining < 2_000) {
      return {
        verdict: null,
        error: `judge ran out of its ${config.timeoutMs}ms budget`,
        durationMs: Date.now() - started,
      };
    }

    const result = await run(config.claudeBin, args, prompt, remaining);

    if (result.kind === 'missing') {
      return {
        verdict: null,
        error: `\`${config.claudeBin}\` is not on PATH`,
        durationMs: Date.now() - started,
      };
    }
    if (result.kind === 'timeout') {
      return {
        verdict: null,
        error: `judge timed out after ${config.timeoutMs}ms`,
        durationMs: Date.now() - started,
      };
    }

    if (result.kind === 'failed') {
      lastError = result.error;
      continue;
    }

    const verdict = parseVerdict(result.stdout);
    if (verdict) return { verdict, durationMs: Date.now() - started };
    lastError = 'judge produced no parseable verdict';
  }

  return { verdict: null, error: lastError, durationMs: Date.now() - started };
}

type RunResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'failed'; error: string }
  | { kind: 'timeout' }
  | { kind: 'missing' };

function run(
  bin: string,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // The one thing standing between this and unbounded recursion.
          FLIPBACK_JUDGE: '1',
          FLIPBACK_DISABLED: '1',
        },
      });
    } catch {
      resolve({ kind: 'missing' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'timeout' });
    }, timeoutMs);
    // Do not hold the process open just for the judge's timer.
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(err.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'failed', error: err.message });
    });

    child.on('close', (code) => {
      if (code === 0) finish({ kind: 'ok', stdout });
      else finish({ kind: 'failed', error: stderr.trim().slice(0, 400) || `exit ${code}` });
    });

    // A broken pipe here means the child died before reading; `close` reports the real reason.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * Digs the verdict out of whatever the CLI produced.
 *
 * Three layers of wrapping are possible: the CLI's own `--output-format json` envelope, a
 * markdown fence the model added, and prose either side of the object. Each is peeled off rather
 * than assumed absent, because assuming makes the judge silently useless on one CLI version.
 */
export function parseVerdict(raw: string): Verdict | null {
  const text = unwrapEnvelope(raw.trim());
  if (!text) return null;

  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.complete !== 'boolean') continue;

    const blocked = record.blocked === true;
    return {
      // A blocked agent has correctly finished its turn, whatever the model put in `complete`.
      complete: record.complete === true || blocked,
      confidence: clampConfidence(record.confidence),
      unfinished: toStringArray(record.unfinished),
      reason: typeof record.reason === 'string' ? record.reason.trim() : '',
      blocked,
      blockedKind: toBlockedKind(record.blocked_kind),
      message: normaliseMessage(record.message),
    };
  }
  return null;
}

/** `claude -p --output-format json` wraps the reply in a result envelope. */
function unwrapEnvelope(raw: string): string {
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      // If it already looks like a verdict, it is not an envelope.
      if (typeof record.complete === 'boolean') return raw;
      if (typeof record.result === 'string') return record.result.trim();
    }
  } catch {
    // Not a complete JSON document; treat it as prose and let the scanner find the object.
  }
  return raw;
}

/** Every balanced `{...}` run in the text, outermost first. */
function jsonCandidates(text: string): string[] {
  const stripped = text.replace(/^```(?:json)?\s*/gm, '').replace(/^```\s*$/gm, '');
  const found: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < stripped.length; j++) {
      const ch = stripped[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          found.push(stripped.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
    if (found.length >= 5) break;
  }
  return found;
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function toBlockedKind(value: unknown): BlockedKind {
  return value === 'authority' || value === 'credential' || value === 'ambiguity' ? value : 'none';
}

const MAX_MESSAGE_CHARS = 1_200;

/**
 * The house style is enforced here rather than trusted to the prompt, because tone is the whole
 * product and a model that drifts once will drift on someone else's install too.
 */
export function normaliseMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(/[—–]/g, ' - ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/!+/g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > MAX_MESSAGE_CHARS) {
    text = `${text.slice(0, MAX_MESSAGE_CHARS).replace(/\s+\S*$/, '')}...`;
  }
  return text;
}
