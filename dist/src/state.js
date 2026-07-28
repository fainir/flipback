import fs from 'node:fs';
import path from 'node:path';
const EMPTY = { continues: 0, userMessages: 0, updatedAt: 0 };
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function safeName(sessionId) {
    const cleaned = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    return `${cleaned.slice(0, 120) || 'unknown'}.json`;
}
function fileFor(stateDir, sessionId) {
    return path.join(stateDir, 'sessions', safeName(sessionId));
}
export function readState(stateDir, sessionId) {
    try {
        const raw = fs.readFileSync(fileFor(stateDir, sessionId), 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return EMPTY;
        const record = parsed;
        return {
            continues: typeof record.continues === 'number' ? record.continues : 0,
            userMessages: typeof record.userMessages === 'number' ? record.userMessages : 0,
            updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        };
    }
    catch {
        return EMPTY;
    }
}
export function writeState(stateDir, sessionId, state) {
    try {
        const file = fileFor(stateDir, sessionId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
    }
    catch {
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
export function continuesSpent(stateDir, sessionId, userMessages) {
    const state = readState(stateDir, sessionId);
    return userMessages > state.userMessages ? 0 : state.continues;
}
export function recordContinue(stateDir, sessionId, userMessages) {
    const spent = continuesSpent(stateDir, sessionId, userMessages);
    const next = spent + 1;
    writeState(stateDir, sessionId, { continues: next, userMessages, updatedAt: Date.now() });
    return next;
}
/** Housekeeping so a long-lived install does not accumulate a file per session forever. */
export function prune(stateDir, now = Date.now()) {
    const dir = path.join(stateDir, 'sessions');
    let files;
    try {
        files = fs.readdirSync(dir);
    }
    catch {
        return;
    }
    for (const name of files) {
        const file = path.join(dir, name);
        try {
            if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS)
                fs.unlinkSync(file);
        }
        catch {
            // Best effort.
        }
    }
}
