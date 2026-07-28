import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-session nudge accounting.
 *
 * `stop_hook_active` alone would cap flipback at exactly one nudge per user turn, which is too
 * timid for a real task. This file is what lets it push two or three times while still having a
 * hard, visible ceiling - because a hook that can nudge without bound is a hook that never lets
 * the agent finish, and that is the one unforgivable failure mode here.
 */

export interface SessionState {
  /** Consecutive nudges issued since the last genuine user message. */
  continues: number;
  /** Snapshot of the user-message count, so a new request resets the counter. */
  userMessages: number;
  updatedAt: number;
}

const EMPTY: SessionState = { continues: 0, userMessages: 0, updatedAt: 0 };
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
  return `${cleaned.slice(0, 120) || 'unknown'}.json`;
}

function fileFor(stateDir: string, sessionId: string): string {
  return path.join(stateDir, 'sessions', safeName(sessionId));
}

export function readState(stateDir: string, sessionId: string): SessionState {
  try {
    const raw = fs.readFileSync(fileFor(stateDir, sessionId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const record = parsed as Record<string, unknown>;
    return {
      continues: typeof record.continues === 'number' ? record.continues : 0,
      userMessages: typeof record.userMessages === 'number' ? record.userMessages : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    };
  } catch {
    return EMPTY;
  }
}

export function writeState(stateDir: string, sessionId: string, state: SessionState): void {
  try {
    const file = fileFor(stateDir, sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
  } catch {
    // Losing the counter degrades to `stop_hook_active` alone, which is still bounded.
  }
}

/**
 * How many nudges have already been spent on the current user request.
 *
 * A *rise* in the user-message count means the person said something new, so the budget resets -
 * whatever happened before that is not this request's problem. A fall is not a reset: it means
 * the transcript tail read further back last time, and treating that as a new request would hand
 * out a fresh budget on a long session, which is exactly the ceiling this file exists to hold.
 */
export function continuesSpent(
  stateDir: string,
  sessionId: string,
  userMessages: number,
): number {
  const state = readState(stateDir, sessionId);
  return userMessages > state.userMessages ? 0 : state.continues;
}

export function recordContinue(
  stateDir: string,
  sessionId: string,
  userMessages: number,
): number {
  const spent = continuesSpent(stateDir, sessionId, userMessages);
  const next = spent + 1;
  writeState(stateDir, sessionId, { continues: next, userMessages, updatedAt: Date.now() });
  return next;
}

/** Housekeeping so a long-lived install does not accumulate a file per session forever. */
export function prune(stateDir: string, now = Date.now()): void {
  const dir = path.join(stateDir, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // Best effort.
    }
  }
}
