#!/usr/bin/env node
// flipback - the agent ended its turn; decide whether it was actually finished.
//
// Exit 2 refuses the stop and sends stderr back to the agent. Exit 0 lets it stop.
// Every error path exits 0: a broken hook must never hold a session open.

import fs from 'node:fs';
import { spawn } from 'node:child_process';

const read = async (s) => { let d = ''; for await (const c of s) d += c; return d; };

/** Last user message, assistant text, and tool names, from the tail of the transcript. */
function conversation(path) {
  const { size } = fs.statSync(path);
  const start = Math.max(0, size - 2_000_000);
  const fd = fs.openSync(path, 'r');
  const buf = Buffer.alloc(size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }

  const rows = buf.toString('utf8').split('\n').slice(start > 0 ? 1 : 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  let request = '', text = [], tools = [], failed = false;
  for (const r of rows) {
    const msg = r.message ?? r;
    const body = msg.content;
    if ((msg.role ?? r.type) === 'user' && !r.isMeta) {
      // A string, or blocks containing real text, is a person talking. Tool results are not.
      const said = typeof body === 'string' ? body
        : Array.isArray(body) && !body.some((b) => b?.type === 'tool_result')
          ? body.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
      const clean = said.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (clean) { request = clean; text = []; tools = []; failed = false; }
    } else if ((msg.role ?? r.type) === 'assistant' && Array.isArray(body)) {
      for (const b of body) {
        if (b?.type === 'text' && b.text?.trim()) text.push(b.text.trim());
        else if (b?.type === 'tool_use') tools.push(b.name);
      }
    } else if (Array.isArray(body)) {
      failed = body.some((b) => b?.type === 'tool_result' && b.is_error) || failed;
    }
  }
  return { request, last: text.at(-1) ?? '', tools, failed };
}

/** Free local check. Most turns are fine and never reach the model. */
function suspicious({ request, last, tools, failed }) {
  if (/\b(stop|that'?s (all|enough|it)|we'?re done|leave it|good enough)\b/i.test(request.slice(-300))) return false;
  const tail = last.slice(-700);
  return failed
    || /\b(?:let me|i'?ll|i will|next[,:]? i'?ll)\s+(?:now\s+)?(?:run|check|verify|test|add|fix|implement|write|update|create|commit)\b/i.test(tail)
    || /\b(?:let me know|would you like|do you want me to|should i\b|shall i\b|before i (?:proceed|continue))/i.test(tail)
    || /\b(?:TODO|FIXME)\b|\bnot (?:yet )?implemented\b|\bplaceholder\b|\bfor now\b|\bout of scope\b|\bstill needs?\b/i.test(last)
    || /^[\t ]*[-*]\s*\[ \]/m.test(last)
    || (tools.some((t) => /^(Edit|Write|MultiEdit)/.test(t)) && !tools.some((t) => t === 'Bash'));
}

const PROMPT = (c) => `A coding agent just ended its turn. Did it do what the user asked, or stop early?

USER ASKED:
${c.request.slice(0, 4000)}

TOOLS IT USED: ${c.tools.join(', ') || '(none)'}${c.failed ? '  [a tool call FAILED]' : ''}

ITS FINAL MESSAGE:
${c.last.slice(-6000)}

INCOMPLETE if: it did some parts of a multi-part request and summarised as if all - count the
parts asked for against the parts that exist, this is the most common failure by far; it said it
would do something and no tool call did it; a command failed and it reported rather than fixed;
it left a TODO or stub as done; it asked a question it could have answered by reading, running,
browsing or looking at the screen; it decided part of the request was out of scope; it changed
something checkable and never checked it.

"I cannot verify this" is almost never a real stop. The agent can run the code, start the server,
call the endpoint, drive a browser, and take a screenshot of the actual screen. Treat an unverified
claim as incomplete when a way to check plainly existed.

COMPLETE if: the work is done and it watched it work; the user asked a question, not for a job;
the user said stop; or it is genuinely blocked and named the blocker specifically - a sign-in,
credential or 2FA code, a payment, an irreversible action it was not asked to take, access only
the user has, or an ambiguity where two readings mean materially different work. A specific
blocker is a complete turn. A vague "I lack permissions" with nothing tried is not.

If you cannot name the specific unfinished thing, it is COMPLETE.

If incomplete, write "message": name the specific unfinished thing, say what the agent already
has that makes it doable (the tools, the error output, the request as authorisation), and end
with one concrete action. Three lines. No em-dashes, no exclamation marks, no praise or scolding.

Reply with only this JSON: {"complete": true|false, "message": "..."}`;

function judge(prompt) {
  return new Promise((resolve) => {
    const kid = spawn('claude', ['-p', '--model', process.env.FLIPBACK_MODEL ?? 'haiku'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      // The judge is itself Claude Code and fires this same hook. Without this it recurses.
      env: { ...process.env, FLIPBACK_OFF: '1' },
    });
    let out = '';
    const timer = setTimeout(() => { kid.kill('SIGKILL'); resolve(null); },
      Number(process.env.FLIPBACK_TIMEOUT_MS ?? 90_000));
    kid.stdout.on('data', (d) => { out += d; });
    kid.on('error', () => { clearTimeout(timer); resolve(null); });
    kid.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/\{[\s\S]*\}/);
      try { resolve(m ? JSON.parse(m[0]) : null); } catch { resolve(null); }
    });
    kid.stdin.on('error', () => {});
    kid.stdin.end(prompt);
  });
}

try {
  if (process.env.FLIPBACK_OFF === '1' || process.env.FLIPBACK_DISABLED === '1') process.exit(0);
  const input = JSON.parse((await read(process.stdin)) || '{}');
  // Set when the agent is already continuing because this hook blocked. One nudge per turn.
  if (input.stop_hook_active) process.exit(0);

  const convo = conversation(input.transcript_path);
  // Nothing to measure the turn against, and a judge given only a final message grades on tone.
  if (!convo.request || convo.last.length < 40 && !convo.failed) process.exit(0);
  if (!suspicious(convo)) process.exit(0);

  const verdict = await judge(PROMPT(convo));
  if (!verdict || verdict.complete !== false || !verdict.message?.trim()) process.exit(0);

  process.stderr.write(
    `${verdict.message.replace(/[—–]/g, ' - ').replace(/!+/g, '.').trim()}\n\n` +
    `If this is wrong - the work really is done, or you need authority, a secret, or a decision ` +
    `only a person can make - say which in one line and end your turn.\n`,
  );
  process.exit(2);
} catch {
  process.exit(0);
}
