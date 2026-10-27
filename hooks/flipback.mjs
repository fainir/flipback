#!/usr/bin/env node
// flipback - the agent ended its turn; decide whether it was actually finished.
//
// Exit 2 refuses the stop and sends stderr back to the agent. Exit 0 lets it stop.
// Every error path exits 0: a broken hook must never hold a session open.

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read = async (s) => { let d = ''; for await (const c of s) d += c; return d; };

// User rows that are the harness talking, not a person: background task results, `!` shell
// output, slash-command output, and the marker left by Esc.
const MACHINE = /^(?:<(?:task-notification|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat)>|\[Request interrupted by user)/;

/** Last user message, assistant text, and tool names, from the tail of the transcript. */
export function conversation(path, maxBytes = 2_000_000) {
  if (typeof path !== 'string' || !path) throw new TypeError('transcript_path is missing');
  const file = path.replace(/^~(?=\/|$)/, os.homedir());
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - start);
  let got = 0;
  try { got = fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }

  const rows = buf.subarray(0, got).toString('utf8').split('\n').slice(start > 0 ? 1 : 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && typeof r === 'object');

  let request = '', text = [], tools = [], failed = false;
  for (const r of rows) {
    if (r.isSidechain) continue;
    const msg = r.message && typeof r.message === 'object' ? r.message : r;
    // Claude Code rows carry the role in `type`. Other row types (api-request-blob, attachment,
    // system, ...) can hold a `message` with a role too, but they are copies, not the conversation.
    const role = msg === r ? r.role ?? r.type : r.type ?? msg.role;
    const body = msg.content;
    if (role === 'user') {
      const blocks = Array.isArray(body) ? body : [];
      // The most recent tool result decides: a failure the agent then fixed is not a failure.
      for (const b of blocks) if (b?.type === 'tool_result') failed = b.is_error === true;
      if (r.isMeta || r.isCompactSummary || blocks.some((b) => b?.type === 'tool_result')) continue;
      // A string, or blocks containing real text, is a person talking. Tool results are not.
      const said = typeof body === 'string' ? body
        : blocks.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
      const clean = said.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (clean && !MACHINE.test(clean)) { request = clean; text = []; tools = []; failed = false; }
    } else if (role === 'assistant') {
      if (typeof body === 'string' && body.trim()) text.push(body.trim());
      else if (Array.isArray(body)) {
        for (const b of body) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) text.push(b.text.trim());
          else if (b?.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name);
        }
      }
    }
  }
  return { request, last: text.at(-1) ?? '', tools, failed };
}

/** Free local check. Most turns are fine and never reach the model. */
export function suspicious({ request, last, tools, failed }) {
  // "stop", "stop here", "ok stop." - but not "fix the stop hook", "why did you stop?" or "don't stop".
  if (/(?<!\b(?:don'?t|do not|never|not)\s)\bstop\b(?=\s*(?:$|[.!,;]|(?:here|now|there|working)\b))|\b(?:that'?s (?:all|enough|it)|we'?re done|leave it|good enough)\b/i.test(request.slice(-300))) return false;
  const tail = last.slice(-700);
  return failed
    || /\b(?:let me|i'?ll|i will|next[,:]? i'?ll)\s+(?:now\s+)?(?:run|check|verify|test|add|fix|implement|write|update|create|commit)\b/i.test(tail)
    || /\b(?:let me know|would you like|do you want me to|should i\b|shall i\b|before i (?:proceed|continue))/i.test(tail)
    || /\b(?:TODO|FIXME)\b|\bnot (?:yet )?implemented\b|\bplaceholder\b|\bfor now\b|\bout of scope\b|\bstill needs?\b/i.test(last)
    || /^[\t ]*[-*]\s*\[ \]/m.test(last)
    || (tools.some((t) => /^(Edit|Write|MultiEdit)/.test(t)) && !tools.some((t) => t === 'Bash'));
}

export const PROMPT = (c) => `A coding agent just ended its turn. Did it do what the user asked, or stop early?

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

ALSO INCOMPLETE: handing the user a to-do list. "Next steps for you", "you'll need to X then Y",
"the remaining items are on you" - work the agent could do with its own tools is never the user's
task. Multiple asks in one turn is the same failure: a human is allowed to be needed for ONE
atomic action, not a checklist.

COMPLETE if: the work is done and it watched it work; the user asked a question, not for a job;
the user said stop; or it is genuinely blocked and named the blocker specifically - a sign-in,
credential or 2FA code, a payment, an irreversible action it was not asked to take, access only
the user has, or an ambiguity where two readings mean materially different work.

A blocked turn only counts as complete when the agent did the preparation first and is asking for
one small action - ideally having already navigated to the exact page or opened the exact file, so
nothing remains but the atomic act only a person can perform. "The login page is open in your
browser, sign in and I will continue" is complete. "You'll need to sign in to GitHub, then upload
the image in Settings" is incomplete: it never opened anything and it asked for two things.

If you cannot name the specific unfinished thing, it is COMPLETE.

If incomplete, write "message": name the specific unfinished thing, say what the agent already
has that makes it doable (the tools, the error output, the request as authorisation), and end
with one concrete action. Three lines. No em-dashes, no exclamation marks, no praise or scolding.

Reply with only this JSON: {"complete": true|false, "message": "..."}`;

/** Ask a small model for a verdict. Resolves null on any failure, never rejects. */
export function judge(prompt, env = process.env) {
  return new Promise((resolve) => {
    let kid;
    try {
      kid = spawn('claude', [
        '-p', '--model', env.FLIPBACK_MODEL || 'haiku',
        // A judge, not an agent: no tools, no MCP servers, no hooks (yours included - a blocking
        // Stop hook would keep the judge running), and nothing saved to the /resume list.
        '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--settings', '{"disableAllHooks":true}',
      ], {
        stdio: ['pipe', 'pipe', 'ignore'],
        // The judge is itself Claude Code and would fire this same hook. Without this it recurses.
        env: { ...env, FLIPBACK_OFF: '1' },
      });
    } catch { resolve(null); return; }
    let out = '';
    const ms = Number(env.FLIPBACK_TIMEOUT_MS);
    const timer = setTimeout(() => { kid.kill('SIGKILL'); resolve(null); }, ms > 0 ? ms : 90_000);
    kid.stdout.on('data', (d) => { out += d; });
    kid.on('error', () => { clearTimeout(timer); resolve(null); });
    kid.on('close', (code) => {
      clearTimeout(timer);
      const m = code === 0 && out.match(/\{[\s\S]*\}/);
      try { resolve(m ? JSON.parse(m[0]) : null); } catch { resolve(null); }
    });
    kid.stdin.on('error', () => {});
    kid.stdin.end(prompt);
  });
}

/** The text that goes back to the agent, or null to let it stop. */
export function nudge(verdict) {
  if (!verdict || verdict.complete !== false) return null;
  if (typeof verdict.message !== 'string' || !verdict.message.trim()) return null;
  // Exclamation marks that end a word go; `!==` and `!ok` in code stay.
  return `${verdict.message.replace(/[–—]/g, ' - ').replace(/!+(?=\s|$)/g, '.').trim()}\n\n` +
    `If this is wrong - the work really is done, or you need authority, a secret, or a decision ` +
    `only a person can make - say which in one line and end your turn.\n`;
}

/** Work that will wake the agent back up. A background shell does not count: a dev server never ends. */
function waiting(input) {
  return (Array.isArray(input.session_crons) && input.session_crons.length > 0)
    || (Array.isArray(input.background_tasks) && input.background_tasks.some((t) => t?.type && t.type !== 'shell'));
}

/** Decide one Stop event. Resolves the message to block with, or null to let the agent stop. */
export async function decide(input, { env = process.env, ask = judge } = {}) {
  if (env.FLIPBACK_OFF === '1' || env.FLIPBACK_DISABLED === '1') return null;
  if (!input || typeof input !== 'object') return null;
  // Set when the agent is already continuing because a stop hook blocked. One nudge per turn.
  if (input.stop_hook_active) return null;
  // A subagent or a scheduled wakeup is still coming back: this is a pause, not a stop.
  if (waiting(input)) return null;

  let convo;
  try { convo = conversation(input.transcript_path); } catch { return null; }
  // The transcript is written asynchronously and can miss the final message at Stop time.
  const final = input.last_assistant_message;
  if (typeof final === 'string' && final.trim()) convo.last = final.trim();

  // Nothing to measure the turn against, and a judge given only a final message grades on tone.
  if (!convo.request || convo.last.length < 40 && !convo.failed) return null;
  if (!suspicious(convo)) return null;
  return nudge(await ask(PROMPT(convo), env));
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    if (process.env.FLIPBACK_OFF === '1' || process.env.FLIPBACK_DISABLED === '1') process.exit(0);
    const message = await decide(JSON.parse((await read(process.stdin)) || '{}'));
    if (message) process.stderr.write(message, () => process.exit(2));
    else process.exit(0);
  } catch {
    process.exit(0);
  }
}
