import type { Slice } from './transcript.js';

/**
 * The cheap local prefilter.
 *
 * Its only job is to decide whether a turn is worth spending a judge call on. It is deliberately
 * not the decision itself: a false positive here costs one small model call, while a false
 * negative costs nothing but a missed nudge. So it errs toward asking.
 *
 * Weights: a strong signal is enough on its own; two weak ones add up to the same thing.
 */

export interface Signal {
  id: string;
  weight: number;
  /** Shown to the judge as "here is why we thought this turn was worth a look". */
  detail: string;
}

export interface Prefilter {
  signals: Signal[];
  score: number;
  /** True when the score cleared the bar and the judge should run. */
  suspicious: boolean;
}

const STRONG = 2;
const WEAK = 1;
const THRESHOLD = 2;

/** Work the agent said it was about to do, in the same breath as ending the turn. */
const ANNOUNCES_NEXT =
  /\b(?:let me|i'?ll|i will|i'?m going to|i am going to|next[,:]? i'?ll|now (?:let me|i'?ll))\s+(?:now\s+|also\s+|then\s+|quickly\s+)?(?:go(?:ing)?\s+)?(?:ahead\s+and\s+)?(?:run|check|verify|test|add|fix|implement|write|update|create|refactor|wire|install|build|commit|clean|remove|migrate|start|continue)\b/i;

/** Asking a person something, at the end of a turn nobody may be watching. */
const ASKS_PERMISSION =
  /\b(?:let me know|would you like|do you want me to|want me to|should i\b|shall i\b|if you'?d like|just say the word|happy to (?:do|add|continue)|before i (?:proceed|continue|go further)|is that (?:ok|okay|right|correct)|does that (?:sound|work|look)|which (?:would you|do you) prefer|your call\b|up to you\b)/i;

/** Explicit admissions that something was left unbuilt. */
const INCOMPLETE_MARKER =
  /\b(?:TODO|FIXME|XXX)\b|\bnot (?:yet )?implemented\b|\bplaceholder\b|\bstub(?:bed|s)?\b|\bleft as an exercise\b|\bin a real (?:implementation|app|system)\b|\bfor now\b|\bfor the (?:time being|moment)\b|\bremains? to be (?:done|implemented|wired)\b|\bwould need to\b|\bstill needs?\b/i;

/** Handing the remainder back to the user rather than doing it. */
const DECLINES_SCOPE =
  /\b(?:out of scope|beyond the scope|outside the scope|i(?:'?ve| have)? left (?:that|this|it|the rest)|leaving (?:that|this|the rest) (?:to|for) you|you (?:can|could|may|might|should|'?ll) (?:then|now|want to|need to)|i did(?:n'?t| not) (?:modify|change|touch|update)|if you want me to)/i;

/** Softening language that usually accompanies a partial job. */
const HEDGES =
  /\b(?:basic version|simplified|minimal (?:version|implementation)|rough(?:ly)?|first pass|starting point|should (?:work|be enough)|i think this|hopefully)\b/i;

/** The turn ends by reporting a problem rather than solving it. */
const REPORTS_FAILURE =
  /\b(?:failed|failing|fails|error(?:s|ed)?|exception|traceback|could not|couldn'?t|unable to|blocked by|does(?:n'?t| not) work|is broken)\b/i;

/** Text that claims verification actually happened. Only trusted alongside a real command. */
const CLAIMS_VERIFIED =
  /\b(?:tests? (?:all )?pass(?:ed|ing)?|all \d+ tests? pass|build (?:succeed|passed|is clean)|type ?check(?:s|ed)? (?:pass|clean)|no errors|verified|confirmed working)\b/i;

/** Commands whose presence means the agent checked its own work. */
const VERIFYING_COMMAND =
  /\b(?:npm (?:test|run test|run build|run typecheck|run lint)|yarn (?:test|build)|pnpm (?:test|build)|jest|vitest|pytest|go test|cargo (?:test|build|check)|make test|tsc\b|node --test|mvn test|gradle test|rspec|phpunit)\b/i;

const EDITING_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|StrReplace)/i;

/** The user explicitly ended things. Nudging over this is the rudest possible false positive. */
const USER_SAID_STOP =
  /\b(?:stop|that'?s (?:all|enough|it)|we'?re done|leave it (?:there|as is)|don'?t (?:continue|do more)|no more|hold off|pause|wait for me|i'?ll take it from here|good enough)\b/i;

function tail(text: string, chars: number): string {
  return text.length > chars ? text.slice(-chars) : text;
}

/** A request with several distinct asks is the one most likely to be partially completed. */
function countRequestParts(request: string): number {
  const bulletLines = (request.match(/^[\t ]*(?:[-*+]|\d+[.)])\s+\S/gm) ?? []).length;
  if (bulletLines >= 2) return bulletLines;

  // Otherwise count imperative-ish clauses joined by "and" / "then" / ",".
  const conjunctions = (request.match(/\b(?:and then|and also|, then|, and|also,|then,)\b/gi) ?? [])
    .length;
  return conjunctions + 1;
}

export function prefilter(slice: Slice): Prefilter {
  const signals: Signal[] = [];
  const add = (id: string, weight: number, detail: string) => signals.push({ id, weight, detail });

  const last = slice.lastAssistantText;
  const lastTail = tail(last, 700);
  const request = slice.userRequest;

  // ---- disqualifiers -------------------------------------------------------
  // These do not just lower the score, they end the check. Continuing past an explicit stop or
  // a direct question to the user would make flipback actively harmful.
  if (USER_SAID_STOP.test(tail(request, 400))) {
    return { signals: [{ id: 'user-said-stop', weight: 0, detail: 'the user asked to stop' }], score: -99, suspicious: false };
  }

  // ---- strong --------------------------------------------------------------
  // Only meaningful if the turn ENDED on text. If a tool call came last, the announced work may
  // well have been the tool call itself.
  if (slice.endedOnText && ANNOUNCES_NEXT.test(lastTail)) {
    add('announced-not-done', STRONG, 'the final message announces an action that never happened');
  }

  if (ASKS_PERMISSION.test(lastTail)) {
    add('asks-permission', STRONG, 'the turn ends by asking the user something');
  }

  if (INCOMPLETE_MARKER.test(last)) {
    add('incomplete-marker', STRONG, 'the final message admits something was left unfinished');
  }

  if (/^[\t ]*[-*]\s*\[ \]/m.test(last)) {
    add('unchecked-checklist', STRONG, 'the final message contains unchecked checklist items');
  }

  if (DECLINES_SCOPE.test(last)) {
    add('declines-scope', STRONG, 'the agent handed part of the work back to the user');
  }

  const lastCall = slice.toolCalls[slice.toolCalls.length - 1];
  if (lastCall?.failed) {
    add('ended-on-failure', STRONG, `the last tool call (${lastCall.name}) failed`);
  }

  // ---- weak ----------------------------------------------------------------
  if (HEDGES.test(last)) {
    add('hedged', WEAK, 'the final message hedges about how complete the work is');
  }

  if (REPORTS_FAILURE.test(lastTail)) {
    add('reports-failure', WEAK, 'the turn ends describing a problem rather than resolving it');
  }

  const parts = countRequestParts(request);
  if (parts >= 3) {
    add('multi-part-request', WEAK, `the request has roughly ${parts} distinct parts`);
  }

  const edited = slice.toolCalls.some((c) => EDITING_TOOL.test(c.name));
  const verified = slice.toolCalls.some(
    (c) => VERIFYING_COMMAND.test(c.summary) || VERIFYING_COMMAND.test(c.name),
  );
  if (edited && !verified) {
    add('unverified-edit', WEAK, 'files were changed but nothing was run to check them');
  }

  // ---- negative ------------------------------------------------------------
  // A claim of success is only worth anything next to a command that could have produced it.
  if (verified && CLAIMS_VERIFIED.test(last) && !lastCall?.failed) {
    add('verified-clean', -WEAK, 'the agent ran a check and reported it passing');
  }

  const score = signals.reduce((total, s) => total + s.weight, 0);
  return { signals, score, suspicious: score >= THRESHOLD };
}

export function describeSignals(signals: Signal[]): string {
  return signals
    .filter((s) => s.weight > 0)
    .map((s) => `- ${s.detail}`)
    .join('\n');
}
