<p align="center">
  <img src="assets/logo.svg" width="112" height="112" alt="flipback">
</p>

<h1 align="center">flipback</h1>

<p align="center">
  <em>Your agent stopped. It was not finished. flipback puts it back on.</em>
</p>

---

Agents stop for bad reasons far more often than for good ones. They finish three of five things
and write a confident summary of all five. They say "now let me run the tests" and end the turn.
They hit one error and hand it back. They ask a question into a terminal nobody is watching.

None of that is a capability limit. It is a stopping habit.

flipback is a Claude Code `Stop` hook. When a turn ends, it reads the conversation, decides
whether the work the user actually asked for got done, and if it did not, it hands the agent one
specific unfinished thing and lets it carry on.

```
Add a slugify() helper to src/text.ts, write unit tests for it, and update
the README with an example.

  ...

  Added slugify() to src/text.ts. It lowercases, strips punctuation and
  collapses whitespace into hyphens.

  Let me now write the tests and update the README.
                                                              [turn ends]

  ┌─ flipback ─────────────────────────────────────────────────────────┐
  │ The request had three parts - add the function, write tests, and   │
  │ update the README - and you completed only the first. Your final   │
  │ message announced the rest, but no tool calls followed. Write the  │
  │ tests for slugify(), then add the README example.                  │
  └────────────────────────────────────────────────────────────────────┘

  [the agent continues, and writes the tests]
```

## Install

```bash
npx flipback install
```

That writes the `Stop` hook into `.claude/settings.json` and drops the skill into
`.claude/skills/`. Add `--global` to do it for every project instead of just this one.

No API key. The judge runs on the Claude Code auth you already have.

```bash
npx flipback doctor
```

confirms the judge can actually run. Worth doing once.

## How it decides

Three stages, cheapest first, because this runs on every single turn you take.

```
turn ends
   │
   ├─ guards         already nudged 3 times? inside our own judge? disabled?  ──► stop
   │
   ├─ prefilter      local pattern check, no model, no network
   │                 nothing suspicious ──────────────────────────────────────► stop
   │                 (the common case, and it is free)
   │
   └─ judge          headless `claude -p` reads the request, the tool calls
                     and the final message
                     work is genuinely done, or genuinely blocked ───────────► stop
                     something specific is outstanding ──────────► keep going
```

The prefilter looks for things like a final message that announces an action no tool call
performed, an unchecked checklist, a `TODO` in the summary, a last tool call that failed, or a
question to the user at the end of a turn. It also *cancels* on a verified clean run, and on the
user having said stop.

The judge is the one that actually decides. It is looking for six specific failures:

| It looks like | It is |
|---|---|
| A summary covering the whole request | Three of five parts done |
| "Now let me run the tests." | The tests were never run |
| An accurate report of a build error | Stopping at a solvable obstacle |
| A finished function | A `TODO` and a hardcoded return |
| "Would you like me to continue?" | A question asked into an empty room |
| "The frontend felt out of scope" | Scope the user did not agree to cut |

And it is just as willing to say the turn was fine. Work that is done and checked, a request that
was a question, a user who said stop, or an agent genuinely blocked on authority or a secret all
end the turn cleanly.

## The tone is the product

An early-stop detector that reads as a nagging linter gets uninstalled in a week. Every message
names the specific unfinished thing, says plainly what the agent already has that makes it
doable, and ends with one concrete action.

> Not done yet - the migration tests still fail on the `orders` table, and that was the point of
> the change. You have the failing output above and write access to the file. Fix the `NOT NULL`
> on `orders.customer_id` and re-run `npm test`.

Never "keep going, you can do it". Encouragement with no target is worse than silence. The house
style is enforced in code, not just asked for in the prompt: em-dashes, exclamation marks and
runaway length are stripped from whatever the judge writes.

## It will not trap your agent

This is the failure mode that matters, so it is bounded three separate ways.

- **A hard ceiling.** Three nudges per user request, then flipback lets go and says so. Tune with
  `FLIPBACK_MAX_CONTINUES`.
- **A way to disagree.** Every message tells the agent how to push back: state in one line that
  the work is done, or that it needs authority, a secret, or a real decision. The judge reads
  that on the next pass and takes it.
- **Every failure path exits 0.** No `claude` on PATH, judge timed out, transcript unreadable,
  service down, unparseable output: the agent stops normally. A hook that holds an agent hostage
  to its own uptime is worse than every early stop combined.

Plus `FLIPBACK_DISABLED=1` turns the whole thing off without uninstalling it.

## The skill

`npx flipback install` also installs a skill, and it does the more important half of the job. The
hook catches a bad stop after the fact; the skill is what stops it happening, by giving the agent
a way to recognise its own early stops and an honest account of what it already has: permission
(the request is the authorisation), the tools, the error message, and more turn than it thinks.

It also states the genuine reasons to stop with equal force, because an agent that will not end
its turn is worse than one that ends it early.

## Optional: reach an actual human

flipback tells an agent it is capable. Sometimes it genuinely is not: it needs an approval, a
credential, or a decision with real stakes behind it. Encouragement is the wrong answer there.

Set `HITL_API_KEY` and a blocked agent gets routed to a real person through
[human-in-da-loop](https://github.com/nirfeinstein/human-in-da-loop) instead of being nudged. If
someone answers while the hook waits, the answer comes back and the agent continues on it.

Entirely opt-in. Without the key, none of it runs and flipback stays standalone.

## Commands

```
flipback install [dir]      wire the hook and skill into a project
flipback install --global   wire them in for every project
flipback uninstall [dir]    remove them again
flipback check [transcript] decide about a transcript without acting on it
flipback doctor             confirm the judge can run
flipback log [n]            recent decisions
```

`flipback check` with no argument picks up your most recent session. It is the honest way to
evaluate this on your own work before letting it run live.

## Configuration

All optional, all environment variables.

| Variable | Default | |
|---|---|---|
| `FLIPBACK_DISABLED` | | `1` turns it off without uninstalling |
| `FLIPBACK_MODE` | `signals` | `signals` judges only suspicious turns. `always` judges every turn - more thorough, costs more. `heuristic` never spawns a judge and nudges on patterns alone |
| `FLIPBACK_MAX_CONTINUES` | `3` | consecutive nudges per user request |
| `FLIPBACK_MODEL` | `haiku` | model for the judge |
| `FLIPBACK_TIMEOUT_MS` | `45000` | hard cap on the judge |
| `FLIPBACK_MIN_CHARS` | `40` | short turns are skipped unless a signal fired |
| `FLIPBACK_DEBUG` | | `1` for verbose output and full nudge text in the log |
| `HITL_API_KEY` | | route genuinely blocked agents to a person |

State and logs live in `~/.flipback`. Only metadata is logged by default: your transcripts
contain your source code, and a background hook quietly accumulating that on disk is not a trade
anyone agreed to. `FLIPBACK_DEBUG=1` opts into the full text.

## Layout

```
src/heuristics.ts   the free prefilter - what makes a turn worth looking at
src/prompt.ts       the judge prompt - what counts as finished
src/judge.ts        the `claude -p` subprocess and verdict parsing
src/decide.ts       the whole decision, with no I/O, so every path is a test
src/state.ts        the nudge ceiling
src/hitl.ts         optional escalation to a person
skills/flipback/    the skill that ships into your install
test/               74 tests
```

## Requirements

Node >= 20, and Claude Code on `PATH`. No runtime dependencies.

## License

MIT
