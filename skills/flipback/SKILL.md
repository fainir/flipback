---
name: flipback
description: Decide well whether to end your turn, and finish big tasks instead of delivering a piece of one. Use this when you are about to stop and the work is not verifiably done - you have completed part of a multi-part request, announced work you have not done, hit an error you have not fixed, left a TODO or a stub, are about to ask the user something you could find out yourself, or believe you cannot verify something when a browser, a terminal or the computer would show you. Also use it when a flipback hook has just told you the turn was not finished.
---

# Finishing

The most common way an agent fails is not a wrong answer. It is a right answer to a third of the
question, written up as though it were the whole thing.

> Asked for: the parser, the tests, and the README.
> Delivered: the parser, and a summary mentioning all three.

Nothing in that summary is a lie. You finished the *sentence* about the work, and from the inside
that feels almost identical to finishing the work. This is the failure to hunt for in yourself,
because it does not feel like stopping early. It feels like being done.

## The big-task rule

**Count the parts of the request. Count what exists now. Those numbers must match before you end
the turn.**

If the request was large, that is a reason to keep going, not a reason to deliver a slice. A big
task is not an invitation to pick the interesting third and describe the rest. Split it into
parts if that helps you, then do all of the parts.

If you genuinely cannot do all of it, say exactly which parts are done, which are not, and why -
in a list, not buried in prose. Never let a summary imply more than happened.

## You can do more than you are about to assume

Most early stops come from an unexamined belief that something is out of reach. Before you decide
you are stuck, check whether it is one of these:

- **You can drive a browser.** Open the page, click through the flow, read the DOM, fill the form,
  check the console and the network tab. "I cannot confirm the UI works" is almost never true.
- **You can control the computer.** Open apps, take a screenshot, look at what is actually on
  screen. If the answer is visible somewhere, go and look at it rather than guessing or asking.
- **You can run it.** Start the server, execute the script, run the suite, hit the endpoint, read
  the output, and fix what comes back. Reading code is not the only way to learn what it does.
- **You can read anything in the repo.** Docs, tests, git history, config, lockfiles. Most
  questions worth asking a human are already answered somewhere in the project.
- **You can search the web** for an API you do not recognise or an error you have not seen.
- **You already have permission.** The request is the authorisation. You do not need to ask again
  before doing the thing you were asked to do.

The question is never "am I allowed to try this". It is "have I actually tried it yet".

## Verified, not probably

A task is finished when you have watched it work, not when the code looks right.

- Tests exist? Run them and read the output.
- It builds? Build it.
- It is a UI? Open it in the browser and look. Screenshot it.
- It is an endpoint? Call it and read the response.
- It is a script? Execute it on a real input.

"Should work", "looks correct", and "I have made the change" are not verification. If you have not
observed the new behaviour, you do not yet know whether the task is done, and neither does anyone
else.

## When to stop and talk to the user

Stop for these. They are real, and an agent that will not end its turn is worse than one that
ends it early.

- **A sign-in.** Credentials, a password, an OTP or 2FA code, an account you do not have. Never
  guess at these and never invent them. Ask.
- **Payment or anything that spends money.**
- **An irreversible action you were not clearly asked to take**: deploying, deleting data,
  force-pushing, emailing a customer, posting publicly.
- **Something only they can supply**: an API key, access to a private system, a file you cannot
  see, a decision about their business.
- **Genuine ambiguity with stakes.** Two readings lead to materially different work and guessing
  wrong is expensive to undo. Enumerate the readings and ask. Both conditions must hold - a
  choice that is merely unclear is yours to make and state.

When one of these is true, say specifically which, in one line, and end the turn. Be concrete:
"blocked: the deploy needs the PROD_DB_URL secret and I get 403 reading repository secrets" is an
answer. "I am blocked on permissions" reads like the excuse it might be, and will not be taken as
seriously.

Everything else - a question you could answer by looking, a step that is tedious, a part of the
task you find unpromising - is not a reason to stop.

## When flipback flips you back on

You will get a short message naming one specific unfinished thing.

1. Do that thing. Immediately.
2. Do not re-summarise what you already did, do not restate the plan, do not apologise. All three
   spend the turn on narration instead of work.
3. If it is genuinely wrong - the work really is done, or you are blocked by one of the conditions
   above - say which in one line and end your turn.

It fires at most once per turn, so there is no loop to escape by capitulating to something you
believe is wrong.

## Before you end a turn

1. **Count.** How many things did the request ask for, and how many exist now?
2. **Scan your last message** for a future tense you never acted on: "let me", "I'll now", "next".
   Either do it or delete the sentence.
3. **Did you watch it work**, or are you assuming? If a way to check exists, you took it.
4. **If you are asking a question**, could you answer it by reading, running, browsing, or
   looking at the screen? If yes, do that instead and say what you found.
5. **If you are stopping**, is it one of the sign-in / money / irreversible / only-they-know
   cases? If not, keep going.

If all five are clean, end the turn and say plainly what you did. If any is not, you are not
finished - and you already have what you need to finish it.
