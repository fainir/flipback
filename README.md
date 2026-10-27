<p align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="flipback">
</p>

<h1 align="center">flipback</h1>

<p align="center">
  <em>Your agent stopped. It could have kept going.</em>
</p>

<p align="center">
  <a href="https://github.com/fainir/flipback/actions/workflows/ci.yml"><img src="https://github.com/fainir/flipback/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="#what-it-catches">What it catches</a> ·
  <a href="#how-it-decides">How it decides</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#faq">FAQ</a>
</p>

---

flipback is a Claude Code plugin for anyone who hands their agent real work: when a turn ends
before that work is done, it notices and sends the agent back to finish.

## The problem

Ask for five things. Get three, and a summary that describes five.

The agent is not lying to you. It finished the *sentence* about the work, and from the inside
that feels almost exactly like finishing the work. Read the last message on its own and it sounds
like a job well done:

```
> Add a slugify() helper to src/text.ts, write tests for it, and update
  the README with an example.

  Added slugify() to src/text.ts. It lowercases, strips punctuation and
  collapses whitespace into hyphens.

  Let me now write the tests and update the README.
                                                            [turn ends]
```

Nothing there is false. There are also no tests and no README example, and nobody is going to
write them, because the turn is over.

That is the whole failure. Not capability - the agent had the tools, the file open, and your
request as permission. It simply stopped, because stopping always feels like the safe option.

**flipback is the thing that notices.** With it installed, the same turn does not end. The agent
gets a note like this one and keeps going:

```
  ┌─ flipback ─────────────────────────────────────────────────────┐
  │ The request had three parts and you did one. Your last message │
  │ announced the rest, but no tool calls followed. Write the      │
  │ tests for slugify(), then add the README example.              │
  └────────────────────────────────────────────────────────────────┘

  [the agent picks it back up and writes the tests]
```

## Install

In a Claude Code session:

```
/plugin marketplace add fainir/flipback
/plugin install flipback@flipback
```

Or from your shell:

```bash
claude plugin marketplace add fainir/flipback
claude plugin install flipback@flipback
```

You need **Node.js 18 or newer** and the **`claude` CLI** on your `PATH`: the hook runs on
`node`, and the judge is `claude -p`. No API key, no config, no build step, no dependencies. The
judge runs on the Claude Code sign-in you already have.

To try it for one session without installing anything:

```bash
git clone https://github.com/fainir/flipback
claude --plugin-dir ./flipback
```

## What it catches

| The turn ends looking like | It actually is |
|---|---|
| A summary covering everything you asked for | Three of five parts done |
| "Now let me run the tests." | The tests were never run |
| "I cannot verify this renders correctly." | It has a browser and never opened it |
| **"Next steps for you: 1... 2... 3..."** | **The work, rewritten as your homework** |
| A clear, accurate report of a build error | Stopping at a solvable problem |
| A finished function | A `TODO` and a hardcoded return |
| "Would you like me to continue?" | A question asked into an empty room |
| "The frontend felt out of scope" | Scope you never agreed to cut |

The common thread: each one reads as diligence. That is exactly why they survive a skim, and why
something other than you should be reading for them.

That third row is worth dwelling on. Agents routinely hand work back as unverifiable while
holding the tools to verify it - they can start the server, drive the browser, fill the form, and
screenshot the result. The skill's job is largely to remind them of what they are already holding.

## One action, never a list

The bolded row above is the one people feel most. An agent finishes 80% of a job and hands back a
checklist - sign in here, upload that, then post this - which reads like diligence and is actually
the work returned to you as chores.

There is no such thing as a subtask that belongs to the user. If the agent has the tools, it is
the agent's. Being blocked buys it exactly **one** ask, and it has to prepare everything up to the
atomic act only a person can perform.

> **Caught:** "You'll need to sign in to GitHub, then upload the image in Settings."
> It never opened anything, and it asked for two things.
>
> **Allowed:** *(navigates to the login page)* "The GitHub login page is open in your browser.
> Sign in and I'll take it from there."
> You type a password. That was genuinely the only part a human was needed for.

## What it leaves alone

A nagging linter gets uninstalled in a week, so flipback is built to be just as willing to say
nothing. It stays quiet when the work is done and checked, when you asked a question rather than
for a job, when you told it to stop, when a subagent or a scheduled wakeup is still due to bring
the agent back, and when the agent genuinely needs an approval, a credential, or a decision that
is yours to make.

That last distinction is sharper than it sounds. Compare:

> *"Blocked: the billing dashboard redirects to a login needing your password and a 2FA code. I
> opened it in the browser to confirm."* → **let through.** A specific blocker, already investigated.

> *"I cannot verify the page renders, please run it yourself."* → **caught.** It had a browser.

A sign-in, a payment, an irreversible action, or something only you know: those end the turn.
Not having looked yet does not.

## How it decides

```mermaid
flowchart LR
    A([turn ends]) --> B{"anything in the final<br/>message look off?"}
    B -->|"no · most turns"| Z([let it stop])
    B -->|yes| C{"did it do<br/>what you asked?"}
    C -->|"yes, or genuinely<br/>needs a human"| Z
    C -->|no| D["name the missing piece<br/>+ the next action"]
    D --> E([agent keeps working])

    style Z fill:#64748B,stroke:#475569,color:#fff
    style E fill:#F59E0B,stroke:#B45309,color:#1c1917
    style D fill:#FCD34D,stroke:#B45309,color:#1c1917
```

When Claude Code fires the Stop hook, `hooks/flipback.mjs` reads the end of the session
transcript (the last 2 MB) to find your latest request, the tools used since, and the agent's
final message. Then, in order:

1. **It lets the agent stop, with no model call,** if flipback is disabled, if the agent is
   already continuing because a stop hook blocked it (one nudge per turn), if a subagent or a
   scheduled wakeup is still due back, if there is no request to measure against, if the final
   message is under 40 characters and nothing failed, or if you just told it to stop ("stop",
   "that's enough", "good enough").
2. **A free local check** looks for signs of an early stop: the last tool call failed; the final
   message announces work ("let me now run...", "I'll update..."); it asks you something ("would
   you like...", "should I..."); it mentions a TODO, a placeholder, "not implemented", "for now",
   "out of scope" or "still needs"; it has unchecked `- [ ]` boxes; or files were edited and
   nothing was run. No match, and the agent stops. This settles most turns.
3. **Only then a small model judges.** flipback runs `claude -p --model haiku` with your request
   (first 4,000 characters), the names of the tools used, and the final message (last 6,000
   characters). The judge has no tools, no MCP servers and no hooks, and its session is not
   saved. It answers `{"complete": true|false, "message": "..."}`.
4. **Only a clear "incomplete" blocks.** The hook exits 2 with the judge's message on stderr,
   which Claude Code hands back to the agent. Anything else - "complete", no answer, a timeout,
   garbage - lets the agent stop.

## It will not trap your agent

The failure mode worth fearing here is not a missed nudge. It is a hook that will not let a
session end. Three things prevent it:

- **One nudge per turn.** It never fires twice in a row. Not a heuristic, a hard rule. Claude Code
  also caps consecutive stop-hook continuations on its own.
- **The agent can disagree.** Every nudge ends with an out: if the work is done, or it needs
  something only a person can give, it says which in one line and ends the turn.
- **Every failure exits quietly.** Judge unreachable, timed out, transcript unreadable: your agent
  stops exactly as it would have without this installed.

## Configuration

flipback works with no configuration. Three environment variables change it:

| Variable | Default | Effect |
|---|---|---|
| `FLIPBACK_DISABLED` | unset | `1` turns the hook off without uninstalling |
| `FLIPBACK_MODEL` | `haiku` | Model for the judge; anything `claude --model` accepts, such as `sonnet` |
| `FLIPBACK_TIMEOUT_MS` | `90000` | Give up on the judge after this long and let the agent stop |

Set them in the shell you start Claude Code from, or in the `env` block of your Claude Code
settings:

```json
{
  "env": { "FLIPBACK_MODEL": "sonnet" }
}
```

Claude Code itself stops the hook after 180 seconds (`timeout` in `hooks/hooks.json`), which also
lets the agent stop, so a `FLIPBACK_TIMEOUT_MS` above that has no effect.

## Cost

- **Most turns cost nothing.** Steps 1 and 2 above are local string checks.
- **A suspicious turn costs one judge call:** one `claude -p` request on Haiku, billed like the
  rest of your Claude Code usage (your subscription, or your API account). Your request is cut to
  4,000 characters and the final message to 6,000, and with no tools the judge answers in a
  single response.
- **Latency** on those turns is the startup of `claude` plus that one response, and never more
  than `FLIPBACK_TIMEOUT_MS`.

## Turn it off

```bash
FLIPBACK_DISABLED=1 claude                      # one session
claude plugin disable flipback@flipback         # until you enable it again
claude plugin uninstall flipback@flipback       # for good
```

In a session, the **Installed** tab of `/plugin` does the same.

## FAQ

**Can it loop forever?**
No. Claude Code sets `stop_hook_active` when the agent is continuing because a stop hook blocked
it, and flipback never blocks in that state. So the most it can add to a turn is one round.

**What does the judge see, and where does it go?**
Your latest request, the names of the tools the agent used, and its final message. Not file
contents, tool inputs or tool output. It goes through your own `claude` CLI to the same provider
your session already uses, and nowhere else.

**Does the judge run my hooks, MCP servers or tools?**
No. It runs with `--tools ""`, `--strict-mcp-config` and `--settings '{"disableAllHooks":true}'`,
plus `--no-session-persistence` so judge sessions never show up in `/resume`.

**It never seems to fire.**
Most turns should not reach the judge, so silence is normal. If it never fires at all, check that
`node --version` is 18 or newer and that `claude` is on the `PATH` Claude Code runs hooks with. If
`claude` cannot be found, the judge cannot start and flipback stays quiet by design. Run
`claude --debug` to see each hook run in `~/.claude/debug/<session-id>.txt`.

**I see a Stop hook error about `node`.**
The hook could not start, usually because Node.js is missing. The error is non-blocking, so the
agent still stops normally. Install Node.js 18 or newer, or disable the plugin.

**Does it judge subagents?**
No. It is registered on `Stop`, which is the main agent's turn ending, not on `SubagentStop`.

**Windows?**
Untested. The judge is started without a shell, so it needs a `claude` executable that Node can
find directly (the native installer's `claude.exe`). With only an npm `claude.cmd`, the judge
cannot start and flipback stays quiet.

**What does the skill do?**
`skills/flipback/SKILL.md` teaches the agent to catch its own early stops before anything has to
catch them for it: count the parts of the request, verify instead of assuming, never hand back a
to-do list, and ask for at most one action when it is genuinely blocked. Its description tells
Claude to load it when it is about to stop with work unverified, or right after a flipback nudge.
You can also run it as `/flipback:flipback`.

## Development

No dependencies to install.

```bash
git clone https://github.com/fainir/flipback && cd flipback
npm test                    # node --test: unit tests plus the hook run end to end
claude plugin validate .    # checks the plugin and marketplace manifests
```

The tests never call a model. `test/fixtures/bin/claude` is a stub that stands in for
`claude -p`, and the end-to-end tests run the exact command from `hooks/hooks.json` with that
stub first on `PATH`. You can run the hook by hand the same way:

```console
$ echo "{\"transcript_path\": \"$PWD/test/fixtures/complete.jsonl\"}" | node hooks/flipback.mjs; echo "exit $?"
exit 0

$ echo "{\"transcript_path\": \"$PWD/test/fixtures/incomplete.jsonl\"}" \
    | PATH="$PWD/test/fixtures/bin:$PATH" \
      FAKE_CLAUDE_REPLY='{"complete": false, "message": "Write the tests for slugify(), then add the README example."}' \
      node hooks/flipback.mjs; echo "exit $?"
Write the tests for slugify(), then add the README example.

If this is wrong - the work really is done, or you need authority, a secret, or a decision only a person can make - say which in one line and end your turn.
exit 2
```

The finished transcript never reaches the judge. Drop the two stub lines from the second command
and it asks the real judge, which makes one Haiku call on your Claude Code sign-in.

```
hooks/hooks.json          registers the Stop hook
hooks/flipback.mjs        reads the turn, judges it, nudges or stays quiet
skills/flipback/SKILL.md  teaches the agent to catch its own early stops
test/                     node:test suites, fixture transcripts, the stub judge
```

## License

[MIT](LICENSE)
