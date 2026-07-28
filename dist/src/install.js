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
/**
 * The directory the package was installed into.
 *
 * This file compiles to `<root>/dist/src/install.js`, so the root is two levels up. Deriving it
 * rather than hardcoding means `npx flipback`, a global install and a git checkout all agree.
 */
export function packageRoot() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
export function claudeDir(scope, targetDir) {
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
export function hookCommand() {
    const entry = path.join(packageRoot(), 'dist', 'src', 'cli.js');
    if (fs.existsSync(entry)) {
        return `node --no-warnings ${JSON.stringify(entry)} stop`;
    }
    return 'npx -y flipback stop';
}
function isOurs(entry) {
    return JSON.stringify(entry).includes(MARKER);
}
function readSettings(settingsPath) {
    if (!fs.existsSync(settingsPath))
        return {};
    const raw = fs.readFileSync(settingsPath, 'utf8').trim();
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            throw new Error('not an object');
        return parsed;
    }
    catch {
        // Overwriting a settings file we cannot parse would destroy someone's configuration.
        throw new Error(`Refusing to touch ${settingsPath}: it is not valid JSON. Fix or move it, then re-run.`);
    }
}
/**
 * Ceiling for the whole hook, and it has to clear the worst case rather than the typical one:
 * a 90s judge plus an optional 45s wait on a human, plus headroom. Claude Code killing the hook
 * mid-decision looks identical to flipback deciding nothing, which is the failure nobody
 * investigates. Almost every turn returns in about a millisecond without reaching either.
 */
const HOOK_TIMEOUT_SECONDS = 180;
export function install(scope, targetDir = process.cwd(), timeoutSeconds = HOOK_TIMEOUT_SECONDS) {
    const base = claudeDir(scope, targetDir);
    const settingsPath = path.join(base, 'settings.json');
    fs.mkdirSync(base, { recursive: true });
    const settings = readSettings(settingsPath);
    const hooks = (settings.hooks ?? {});
    const existing = Array.isArray(hooks.Stop) ? hooks.Stop : [];
    const command = hookCommand();
    const entry = {
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
function installSkill(base) {
    const source = path.join(packageRoot(), 'skills', 'flipback', 'SKILL.md');
    const destDir = path.join(base, 'skills', 'flipback');
    const dest = path.join(destDir, 'SKILL.md');
    if (!fs.existsSync(source))
        return '';
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(source, dest);
    return dest;
}
export function uninstall(scope, targetDir = process.cwd()) {
    const base = claudeDir(scope, targetDir);
    const settingsPath = path.join(base, 'settings.json');
    let removedHooks = 0;
    if (fs.existsSync(settingsPath)) {
        const settings = readSettings(settingsPath);
        const hooks = (settings.hooks ?? {});
        if (Array.isArray(hooks.Stop)) {
            const kept = hooks.Stop.filter((e) => !isOurs(e));
            removedHooks = hooks.Stop.length - kept.length;
            // Leave no empty scaffolding behind that we did not find.
            if (kept.length === 0)
                delete hooks.Stop;
            else
                hooks.Stop = kept;
            if (Object.keys(hooks).length === 0)
                delete settings.hooks;
            else
                settings.hooks = hooks;
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
    }
    catch {
        // Nothing here is worth failing an uninstall over.
    }
    return { settingsPath, removedHooks, removedSkill };
}
export function isInstalled(scope, targetDir = process.cwd()) {
    const settingsPath = path.join(claudeDir(scope, targetDir), 'settings.json');
    try {
        const settings = readSettings(settingsPath);
        const hooks = (settings.hooks ?? {});
        return Array.isArray(hooks.Stop) && hooks.Stop.some(isOurs);
    }
    catch {
        return false;
    }
}
