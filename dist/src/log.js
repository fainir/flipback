import fs from 'node:fs';
import path from 'node:path';
/**
 * A local record of what flipback decided and why.
 *
 * Only metadata is written by default. The transcript contains the user's source code and their
 * conversation, and a background hook quietly accumulating that on disk is not a trade anyone
 * agreed to. `FLIPBACK_DEBUG=1` opts into the full text, for people tuning their own thresholds.
 */
const MAX_LINES = 500;
export function logDecision(config, sessionId, decision) {
    const detail = decision.detail ?? {};
    const record = {
        at: new Date().toISOString(),
        session: sessionId,
        action: decision.action,
        why: decision.why,
        ...(decision.action === 'block' ? { nudge: decision.nudge } : {}),
        ...(detail.signals?.length ? { signals: detail.signals } : {}),
        ...(typeof detail.score === 'number' ? { score: detail.score } : {}),
        ...(typeof detail.judgeMs === 'number' ? { judgeMs: detail.judgeMs } : {}),
        ...(detail.judgeError ? { judgeError: detail.judgeError } : {}),
        ...(detail.verdict ? { confidence: detail.verdict.confidence } : {}),
        ...(detail.verdict?.unfinished.length ? { unfinished: detail.verdict.unfinished } : {}),
        ...(config.debug && decision.action === 'block' ? { message: decision.message } : {}),
    };
    try {
        const file = path.join(config.stateDir, 'log.jsonl');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
        trim(file);
    }
    catch {
        // Logging is a convenience. It must never be the reason a hook misbehaves.
    }
}
/** Keeps the log to a bounded size without needing logrotate. */
function trim(file, maxLines = MAX_LINES) {
    try {
        const stat = fs.statSync(file);
        // Rewriting on every append would be wasteful; only bother once the file could plausibly
        // be over the limit at a generous average line length.
        if (stat.size < maxLines * 400)
            return;
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        if (lines.length <= maxLines)
            return;
        fs.writeFileSync(file, `${lines.slice(-maxLines).join('\n')}\n`);
    }
    catch {
        // Ignore.
    }
}
export function readLog(config, limit = 20) {
    try {
        const file = path.join(config.stateDir, 'log.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        return lines
            .slice(-limit)
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((r) => r !== null);
    }
    catch {
        return [];
    }
}
