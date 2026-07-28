import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';

/** Builders for the JSONL entries Claude Code writes, so tests read like conversations. */

export const user = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: text },
});

export const assistant = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

export const toolResult = (id: string, content: string, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
});

export const meta = (text: string) => ({
  type: 'user',
  isMeta: true,
  message: { role: 'user', content: text },
});

let counter = 0;

export function writeTranscript(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipback-test-'));
  const file = path.join(dir, `t${counter++}.jsonl`);
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flipback-dir-'));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    stateDir: tempDir(),
    ...overrides,
  };
}
