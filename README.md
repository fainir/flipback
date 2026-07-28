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

No API key, no config, no build. It uses the Claude Code auth you already have.

## What it does

Your agent ends its turn. flipback reads the conversation, works out whether the thing you asked
for actually got done, and if it did not, hands the agent the specific unfinished piece.

```
> Add a slugify() helper, write tests for it, and update the README.

  Added slugify() to src/text.ts.
  Let me now write the tests and update the README.
                                                          [turn ends]

  ┌─ flipback ─────────────────────────────────────────────────────┐
  │ The request had three parts and you did one. Your last message │
  │ announced the rest, but no tool calls followed. Write the      │
  │ tests for slugify(), then add the README example.              │
  └────────────────────────────────────────────────────────────────┘

  [the agent picks it back up]
```

It catches partial work summarised as complete, announced-but-not-done work, stopping at the
first error, TODOs left as finished, questions asked into an empty room, and scope you did not
agree to cut.

It leaves a turn alone when the work is done, when you asked a question rather than for a job,
when you said stop, or when the agent genuinely needs an approval or a credential.

## It will not trap your agent

- **One nudge per turn.** It never fires twice in a row.
- **The agent can disagree** and be taken at its word.
- **Every failure exits quietly.** Judge unreachable, timed out, transcript unreadable: your
  agent stops normally.

Off switch: `export FLIPBACK_DISABLED=1`.

## Cost

Almost nothing. A local pattern check settles most turns for free. Only a turn that looks
unfinished goes to a small model.

## What is in here

```
hooks/flipback.mjs        the hook: read the turn, judge it, nudge or stay quiet
skills/flipback/SKILL.md  teaches the agent to catch its own early stops
```

Two files. No dependencies, no build step, no npm package.

## License

MIT
