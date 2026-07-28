const TITLE_MAX = 200;
export function shouldEscalate(config, verdict) {
    return Boolean(config.hitlKey) && verdict.blocked && verdict.blockedKind !== 'none';
}
const URGENCY = {
    authority: 'high',
    credential: 'high',
    ambiguity: 'normal',
};
export async function escalate(config, verdict, context) {
    const type = verdict.blockedKind === 'authority'
        ? 'approval'
        : verdict.blockedKind === 'credential'
            ? 'credential'
            : 'question';
    const controller = new AbortController();
    // Always leave headroom under the hook timeout, or Claude Code kills us mid-request.
    const budgetMs = config.hitlWaitSeconds * 1000;
    const timer = setTimeout(() => controller.abort(), budgetMs + 10_000);
    try {
        const response = await fetch(`${config.hitlUrl}/v1/requests`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${config.hitlKey}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                type,
                title: firstLine(verdict.unfinished[0] ?? verdict.reason),
                body: [
                    `An agent stopped because it needs a person.`,
                    '',
                    `What it was asked to do: ${context.userRequest.slice(0, 1_000)}`,
                    '',
                    `Why it cannot continue: ${verdict.reason}`,
                    verdict.unfinished.length ? `\nOutstanding:\n${verdict.unfinished.map((u) => `- ${u}`).join('\n')}` : '',
                ].join('\n'),
                urgency: URGENCY[verdict.blockedKind] ?? 'normal',
                agent_name: 'claude-code',
                agent_session: context.sessionId,
                thread_key: context.sessionId,
                tags: ['flipback', verdict.blockedKind],
                context: { cwd: context.cwd, source: 'flipback' },
                wait_ms: budgetMs,
            }),
            signal: controller.signal,
        });
        if (!response.ok)
            return null;
        const data = await response.json();
        if (typeof data !== 'object' || data === null)
            return null;
        const record = data;
        return {
            outcome: typeof record.outcome === 'string' ? record.outcome : 'unknown',
            requestId: typeof record.request_id === 'string' ? record.request_id : '',
            answer: formatAnswer(record.answer),
            coaching: typeof record.coaching === 'string' ? record.coaching : '',
        };
    }
    catch {
        // The service being down must never change what flipback does. Fall back to the nudge.
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
function firstLine(text) {
    const line = text.split('\n').find((l) => l.trim()) ?? text;
    return line.trim().slice(0, TITLE_MAX) || 'An agent needs a person';
}
function formatAnswer(answer) {
    if (typeof answer !== 'object' || answer === null)
        return '';
    const record = answer;
    const parts = [];
    if (typeof record.approved === 'boolean')
        parts.push(record.approved ? 'APPROVED' : 'REJECTED');
    if (typeof record.choice === 'string')
        parts.push(`Chose: ${record.choice}`);
    for (const key of ['text', 'reason', 'notes']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim())
            parts.push(value.trim());
    }
    return parts.join('\n');
}
