import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Wiring flipback into a Claude Code install.
 *
 * Two artifacts, and both are needed. The hook is what actually catches a stop; the skill is what
 * makes the agent handle being caught well, and what teaches it to recognise a bad stop before
 * the hook has to. Installing one without the other gets you half a product.
 */

const MARKER = 'flipback';

export interface InstallResult {
  settingsPath: string;
  skillPath: string;
  command: string;
}

/**
 * The directory the package was installed into.
 *
 * This file compiles to `<root>/dist/src/install.js`, so the root is two levels up. Deriving it
 * rather than hardcoding means `npx flipback`, a global install and a git checkout all agree.
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function claudeDir(scope: 'project' | 'user', targetDir: string): string {
  return scope === 'user'
    ? path.join(os.homedir(), '.claude')
    : path.join(targetDir, '.claude');
}

/**
 * The command Claude Code will run for the hook.
 *
 * An absolute path to the installed file beats `npx flipback` by a wide margin: npx re-resolves
 * the package on every single turn, and this runs on every single turn.
 */
export function hookCommand(): string {
  const entry = path.join(packageRoot(), 'dist', 'src', 'cli.js');
  if (fs.existsSync(entry)) {
    return `node --no-warnings ${JSON.stringify(entry)} stop`;
  }
  return 'npx -y flipback stop';
}

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

function isOurs(entry: unknown): boolean {
  return JSON.stringify(entry).includes(MARKER);
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    // Overwriting a settings file we cannot parse would destroy someone's configuration.
    throw new Error(
      `Refusing to touch ${settingsPath}: it is not valid JSON. Fix or move it, then re-run.`,
    );
  }
}

export function install(
  scope: 'project' | 'user',
  targetDir: string = process.cwd(),
  timeoutSeconds = 120,
): InstallResult {
  const base = claudeDir(scope, targetDir);
  const settingsPath = path.join(base, 'settings.json');
  fs.mkdirSync(base, { recursive: true });

  const settings = readSettings(settingsPath);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];

  const command = hookCommand();
  const entry: HookEntry = {
    hooks: [{ type: 'command', command, timeout: timeoutSeconds }],
  };

  // Idempotent by construction: drop anything a previous install wrote, then append the current
  // one. Re-running install after an upgrade must not leave two hooks racing each other.
  hooks.Stop = [...existing.filter((e) => !isOurs(e)), entry];
  settings.hooks = hooks;

  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const skillPath = installSkill(base);
  return { settingsPath, skillPath, command };
}

function installSkill(base: string): string {
  const source = path.join(packageRoot(), 'skills', 'flipback', 'SKILL.md');
  const destDir = path.join(base, 'skills', 'flipback');
  const dest = path.join(destDir, 'SKILL.md');
  if (!fs.existsSync(source)) return '';
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(source, dest);
  return dest;
}

export interface UninstallResult {
  settingsPath: string;
  removedHooks: number;
  removedSkill: boolean;
}

export function uninstall(
  scope: 'project' | 'user',
  targetDir: string = process.cwd(),
): UninstallResult {
  const base = claudeDir(scope, targetDir);
  const settingsPath = path.join(base, 'settings.json');

  let removedHooks = 0;
  if (fs.existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    if (Array.isArray(hooks.Stop)) {
      const kept = (hooks.Stop as unknown[]).filter((e) => !isOurs(e));
      removedHooks = hooks.Stop.length - kept.length;
      // Leave no empty scaffolding behind that we did not find.
      if (kept.length === 0) delete hooks.Stop;
      else hooks.Stop = kept;
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      else settings.hooks = hooks;
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }
  }

  const skillDir = path.join(base, 'skills', 'flipback');
  let removedSkill = false;
  try {
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      removedSkill = true;
    }
  } catch {
    // Nothing here is worth failing an uninstall over.
  }

  return { settingsPath, removedHooks, removedSkill };
}

export function isInstalled(scope: 'project' | 'user', targetDir: string = process.cwd()): boolean {
  const settingsPath = path.join(claudeDir(scope, targetDir), 'settings.json');
  try {
    const settings = readSettings(settingsPath);
    const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
    return Array.isArray(hooks.Stop) && (hooks.Stop as unknown[]).some(isOurs);
  } catch {
    return false;
  }
}
