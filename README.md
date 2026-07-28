<p align="center">
  <img src="assets/logo.svg" width="104" height="104" alt="flipback">
</p>

<h1 align="center">flipback</h1>

<p align="center">
  <em>Your agent stopped. It was not finished. flipback puts it back on.</em>
</p>

## Install

```
/plugin marketplace add fainir/flipback
/plugin install flipback
```

That is it. No API key, no config. It uses the Claude Code auth you already have.

## What it does

Your agent ends its turn. flipback reads the conversation, works out whether the thing you asked
for actually got done, and if it did not, hands the agent the specific unfinished piece so it
carries on.

```
> Add a slugify() helper, write tests for it, and update the README.

  Added slugify() to src/text.ts. It lowercases, strips punctuation and
  collapses whitespace into hyphens.

  Let me now write the tests and update the README.
                                                            [turn ends]

  ┌─ flipback ───────────────────────────────────────────────────────┐
  │ The request had three parts and you did one. Your last message   │
  │ announced the rest, but no tool calls followed. Write the tests  │
  │ for slugify(), then add the README example.                      │
  └──────────────────────────────────────────────────────────────────┘

  [the agent picks it back up and writes the tests]
```

## What it catches

| It looks like | It is |
|---|---|
| A summary covering the whole request | Three of five parts done |
| "Now let me run the tests." | The tests were never run |
| An accurate report of a build error | Stopping at a solvable obstacle |
| A finished function | A `TODO` and a hardcoded return |
| "Would you like me to continue?" | A question asked into an empty room |
| "The frontend felt out of scope" | Scope you did not agree to cut |

It is just as willing to leave a turn alone. Work that is done and checked, a question you asked
rather than a job, an agent genuinely blocked on an approval or a credential: all end cleanly.

## It will not trap your agent

- **Three nudges per request, then it stops.** A hard ceiling, not a heuristic.
- **The agent can disagree.** Saying "this is done" or "I need an approval you have not given"
  is taken as an answer.
- **Every failure exits quietly.** Judge unreachable, timed out, transcript unreadable: your
  agent stops normally. It never holds a session hostage.

Not for you today? `export FLIPBACK_DISABLED=1`, or `/plugin uninstall flipback`.

## Cost

Almost nothing. A local pattern check runs first and settles the large majority of turns for
free. Only a turn that looks unfinished goes to a small model, which takes about 15 to 30
seconds and reads only the current turn.

## Settings

All optional.

| | |
|---|---|
| `FLIPBACK_DISABLED=1` | turn it off without uninstalling |
| `FLIPBACK_MAX_CONTINUES` | nudges per request, default `3` |
| `FLIPBACK_MODE` | `signals` (default), `always` for every turn, `heuristic` for no model calls |
| `FLIPBACK_MODEL` | judge model, default `haiku` |

## Try it before you trust it

```bash
npx github:fainir/flipback check
```

Runs the same decision over your most recent session and prints what it would have said, without
touching anything.

## Without the plugin system

```bash
git clone https://github.com/fainir/flipback && cd flipback
node dist/src/cli.js install          # this project, or --global for all of them
node dist/src/cli.js doctor           # check the judge can run
```

Node 20 or newer, Claude Code on your `PATH`, no dependencies.

## License

MIT
