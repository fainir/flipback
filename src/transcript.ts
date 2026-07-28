import fs from 'node:fs';

/**
 * Reads a Claude Code transcript into the slice a judge actually needs: what the user asked for,
 * and everything the agent did about it since.
 *
 * The transcript is JSONL whose shape has drifted across Claude Code versions, so every field
 * access here is defensive. A parser that throws would stop the hook from exiting cleanly, and a
 * hook that cannot exit cleanly is worse than no hook at all.
 */

export interface ToolCall {
  name: string;
  /** A one-line rendering of the arguments, for the judge to read. Truncated hard. */
  summary: string;
  /** Set when the matching tool_result came back flagged as an error. */
  failed: boolean;
  errorText?: string;
}

export interface Slice {
  /** The most recent genuine user message - not a tool result, not a system reminder. */
  userRequest: string;
  /** Every assistant text block since that message, in order. */
  assistantText: string;
  /** Just the final one. Most heuristics care about this and not the rest. */
  lastAssistantText: string;
  toolCalls: ToolCall[];
  /** Whether the agent produced text after its last tool call, or ended on the tool. */
  endedOnText: boolean;
  /** How many genuine user messages the transcript contains. Used to reset the nudge counter. */
  userMessageCount: number;
}

export const EMPTY_SLICE: Slice = {
  userRequest: '',
  assistantText: '',
  lastAssistantText: '',
  toolCalls: [],
  endedOnText: false,
  userMessageCount: 0,
};

/** Read the tail of a file as UTF-8, dropping a leading partial line. */
function readTail(filePath: string, maxBytes: number): string[] {
  let raw: string;
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return [];
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      raw = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = raw.split('\n');
    if (start > 0 && lines.length > 1) lines.shift();
    return lines;
  } catch {
    return [];
  }
}

type Entry = Record<string, unknown>;

function parseLines(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) entries.push(parsed as Entry);
    } catch {
      // A truncated or unfamiliar line is not worth failing the whole read over.
    }
  }
  return entries;
}

function contentOf(entry: Entry): unknown {
  const message = entry.message as Entry | undefined;
  return message?.content ?? entry.content;
}

function roleOf(entry: Entry): string {
  const message = entry.message as Entry | undefined;
  const role = message?.role ?? entry.role ?? entry.type;
  return typeof role === 'string' ? role : '';
}

/**
 * A "genuine" user message is one a person typed.
 *
 * Claude Code writes three other things into the same `user` role: tool results, system
 * reminders (`isMeta`), and compaction summaries. Treating any of those as the request would
 * point the judge at the wrong thing entirely.
 */
function genuineUserText(entry: Entry): string | null {
  if (roleOf(entry) !== 'user') return null;
  if (entry.isMeta === true || entry.isCompactSummary === true) return null;

  const content = contentOf(entry);

  if (typeof content === 'string') {
    const text = stripReminders(content).trim();
    return text ? text : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Entry;
    // An array containing tool_result blocks is the agent's own loop, not a person speaking.
    if (b.type === 'tool_result') return null;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  const text = stripReminders(parts.join('\n')).trim();
  return text ? text : null;
}

/** System reminders are injected into user turns and are not part of what the person asked. */
function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
}

function summariseToolInput(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Entry;
  // The fields worth showing differ per tool; these cover the ones that carry the intent.
  const preferred = ['command', 'file_path', 'pattern', 'path', 'query', 'url', 'description'];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return `${key}=${oneLine(value, 160)}`;
    }
  }
  return oneLine(JSON.stringify(record), 160);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function readSlice(transcriptPath: string, maxBytes = 2 * 1024 * 1024): Slice {
  const entries = parseLines(readTail(transcriptPath, maxBytes));
  if (entries.length === 0) return EMPTY_SLICE;

  let userMessageCount = 0;
  let lastUserIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    if (genuineUserText(entries[i]!) !== null) {
      userMessageCount++;
      lastUserIndex = i;
    }
  }

  const userRequest = lastUserIndex >= 0 ? (genuineUserText(entries[lastUserIndex]!) ?? '') : '';

  // Results arrive in a later entry than the call, so collect them first and join by id.
  const errorsById = new Map<string, string>();
  for (let i = lastUserIndex + 1; i < entries.length; i++) {
    const content = contentOf(entries[i]!);
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Entry;
      if (b.type !== 'tool_result') continue;
      const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
      if (!id) continue;
      const failed = b.is_error === true;
      if (failed) errorsById.set(id, oneLine(renderResult(b.content), 300));
    }
  }

  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let endedOnText = false;

  for (let i = lastUserIndex + 1; i < entries.length; i++) {
    const entry = entries[i]!;
    if (roleOf(entry) !== 'assistant') continue;
    const content = contentOf(entry);

    if (typeof content === 'string') {
      if (content.trim()) {
        textParts.push(content.trim());
        endedOnText = true;
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Entry;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        textParts.push(b.text.trim());
        endedOnText = true;
      } else if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const id = typeof b.id === 'string' ? b.id : '';
        const errorText = id ? errorsById.get(id) : undefined;
        toolCalls.push({
          name,
          summary: summariseToolInput(name, b.input),
          failed: errorText !== undefined,
          ...(errorText ? { errorText } : {}),
        });
        endedOnText = false;
      }
    }
  }

  return {
    userRequest,
    assistantText: textParts.join('\n\n'),
    lastAssistantText: textParts[textParts.length - 1] ?? '',
    toolCalls,
    endedOnText,
    userMessageCount,
  };
}

function renderResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (typeof block === 'object' && block !== null) {
      const b = block as Entry;
      if (typeof b.text === 'string') parts.push(b.text);
    }
  }
  return parts.join('\n');
}

/** Reads and parses the hook payload Claude Code writes to stdin. */
export async function readHookInput(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
  } catch {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}
