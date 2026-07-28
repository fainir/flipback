import { insideJudge } from './config.js';
import { prefilter } from './heuristics.js';
import { judge as runJudge } from './judge.js';
import { buildJudgePrompt } from './prompt.js';
import { escalate as runEscalate, shouldEscalate } from './hitl.js';
import { continuesSpent, recordContinue } from './state.js';
import { readSlice, str } from './transcript.js';
export const defaultDeps = {
    readSlice: (path) => readSlice(path),
    judge: runJudge,
    escalate: runEscalate,
    continuesSpent,
    recordContinue,
    env: process.env,
};
const allow = (why, detail) => ({ action: 'allow', why, detail });
export async function decide(payload, config, overrides = {}) {
    const deps = { ...defaultDeps, ...overrides };
    // ---- guards --------------------------------------------------------------
    // Ordered cheapest-first, and every one of them is a reason flipback must stay silent.
    if (insideJudge(deps.env))
        return allow('running inside flipback\'s own judge');
    if (config.mode === 'off')
        return allow('disabled by configuration');
    const transcriptPath = str(payload, 'transcript_path');
    if (!transcriptPath)
        return allow('no transcript path in the hook payload');
    const slice = deps.readSlice(transcriptPath);
    if (!slice.userRequest && !slice.lastAssistantText && slice.toolCalls.length === 0) {
        return allow('nothing readable in the transcript');
    }
    // Everything flipback decides is "did this turn do what was asked". With no request in the
    // readable window there is nothing to measure the turn against, and a judge handed only a
    // final message will grade it on tone. Seen for real on a session that died mid-run: the last
    // thing in it was an API limit notice, with no user turn behind it.
    //
    // This is a distinct outcome rather than a silent allow, so `flipback log` shows it. If it
    // shows up often the tail window is too small, which is a fixable problem - but only if it is
    // visible.
    if (!slice.userRequest) {
        return allow('no user request in the readable transcript window - nothing to judge against');
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
    const pre = prefilter(slice);
    const detail = { signals: pre.signals.map((s) => s.id), score: pre.score };
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
    if (!outcome.verdict)
        return allow(outcome.error ?? 'judge produced no verdict', detail);
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
function header(nudge, max) {
    return nudge >= max ? `[flipback ${nudge}/${max}, last one]` : `[flipback ${nudge}/${max}]`;
}
const DISAGREE = 'If this is wrong - the work really is done, or you need authority, a secret, or a decision ' +
    'only a person can make - say which in one line and end your turn.';
function nudgeMessage(body, nudge, max) {
    return `${header(nudge, max)}\n\n${body}\n\n${DISAGREE}\n`;
}
function humanAnsweredMessage(answer) {
    return [
        '[flipback] A person answered the thing you were blocked on:',
        '',
        answer,
        '',
        'Act on that and continue.',
        '',
    ].join('\n');
}
function humanCoachingMessage(coaching) {
    return [
        '[flipback] This does not need a person. Triage sent back:',
        '',
        coaching,
        '',
        'Do that, then continue.',
        '',
    ].join('\n');
}
function heuristicMessage(pre, nudge, max) {
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
