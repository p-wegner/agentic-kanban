/**
 * Compose-file I/O, host-port discovery, and services.env generation for the
 * per-workspace Docker Compose engine (workspace-services.service.ts).
 *
 * Split out of that file (#889 god-module gate) as a cohesive sub-module: everything
 * here is about READING compose files (+ their include:/extends: references) and
 * PRODUCING the generated `.kanban/services.env`, as opposed to the engine's actual
 * up/down/list lifecycle orchestration. Re-exported through the original file's facade
 * barrel so no consumer's import path changes (see agent-stream-parser.ts for the
 * established pattern).
 */

import { writeFile, readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import type { ServiceStackConfig } from "@agentic-kanban/shared";
import {
  findSiblingComposeRelativePaths,
  siblingComposeRelativePathWarning,
  extractComposeFileReferences,
} from "@agentic-kanban/shared";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export async function ensureKanbanDirGitIgnored(worktreePath: string): Promise<void> {
  try {
    await writeFile(join(worktreePath, ".kanban", ".gitignore"), "*\n", { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    console.warn(`[services] failed to write .kanban/.gitignore sentinel (services.env may show up in diffs): ${errorMessage(err)}`);
  }
}

/** Uppercase + sanitize a port name into an env-var-safe token: KANBAN_SVC_<NAME>_PORT. */
export function portEnvVar(name: string): string {
  return `KANBAN_SVC_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`;
}

/**
 * Read a compose file and follow its `include:`/`extends: file:` references ONE level
 * deep (dev #162) — resolved relative to EACH referenced file's own directory, matching
 * how docker compose itself resolves those directives (unlike the `-f` multi-project-dir
 * quirk #109 targets). Returns the primary file's text plus every readable referenced
 * file's text. Best-effort: a missing/unreadable primary or reference contributes
 * nothing rather than throwing — a compose file appearing in multiple lists (e.g. a
 * shared base extended by two services) is naturally deduped by the caller's Map.
 */
export async function readComposeFileShallow(absPath: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  let text: string;
  try {
    text = await readFile(absPath, "utf-8");
  } catch {
    return out;
  }
  out.push({ path: absPath, text });
  const fileDir = dirname(absPath);
  for (const ref of extractComposeFileReferences(text)) {
    const refAbs = join(fileDir, ref);
    try {
      const refText = await readFile(refAbs, "utf-8");
      out.push({ path: refAbs, text: refText });
    } catch {
      continue;
    }
  }
  return out;
}

/** Expand a list of compose files (primary + siblings) one level via `readComposeFileShallow`, deduped by resolved path. */
export async function expandComposeFilesShallow(composeFiles: string[]): Promise<Array<{ path: string; text: string }>> {
  const seen = new Map<string, string>();
  for (const file of composeFiles) {
    for (const { path, text } of await readComposeFileShallow(file)) {
      if (!seen.has(path)) seen.set(path, text);
    }
  }
  return [...seen.entries()].map(([path, text]) => ({ path, text }));
}

/**
 * Discover host-port names referenced via `${KANBAN_SVC_<NAME>_PORT}` across a compose
 * file, its siblings, AND anything they pull in via `include:`/`extends:` (one level,
 * dev #162) that are NOT already declared in `existingNames` (#71 union port
 * allocation). Lets a sibling repo — or a file it includes/extends — ship its OWN
 * published ports (a broker, a second DB, …) and have them allocated + injected, instead
 * of being limited to the project's declared port block. Deduped by the canonical env
 * var so "db" (declared) and a compose's "DB" reference never double-allocate.
 * Best-effort text scan (not full YAML) — an unreadable file contributes nothing.
 */
export async function discoverComposePortNames(composeFiles: string[], existingNames: string[]): Promise<string[]> {
  const seenEnv = new Set(existingNames.map(portEnvVar));
  const discovered: string[] = [];
  const re = /KANBAN_SVC_([A-Z0-9_]+?)_PORT/g;
  const expanded = await expandComposeFilesShallow(composeFiles);
  for (const { text } of expanded) {
    for (const m of text.matchAll(re)) {
      const name = m[1].toLowerCase();
      const env = portEnvVar(name);
      if (seenEnv.has(env)) continue;
      seenEnv.add(env);
      discovered.push(name);
    }
  }
  return discovered;
}

/**
 * Host the agent should reach the stack's services on. Defaults to `localhost` (the
 * single-user, board-on-host case). When the board itself runs in a container the DB
 * lives elsewhere: DooD → `host.docker.internal`; DinD → the `dind` sidecar service
 * name. The deployment sets `KANBAN_SERVICE_HOST` accordingly. (F2)
 */
export function resolveServiceHost(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.KANBAN_SERVICE_HOST?.trim();
  return v && v.length > 0 ? v : "localhost";
}

/** Keys must be valid POSIX shell identifiers or `. services.env` breaks mid-file. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The generated file has TWO consumers with different parsers: docker's `--env-file`
 * format and the POSIX shell dot-source the ticket-context tells the agent to run
 * (`set -a; . .kanban/services.env; set +a`). Values are emitted SINGLE-QUOTED — the
 * one representation both parsers read back byte-identically (no `$` interpolation,
 * no ` #` inline-comment truncation, no word splitting) — so an entry is safe only if:
 *  - the key is a valid shell identifier (a `MY-VAR=…` line aborts the dot-source), and
 *  - the value carries no line break (would split one KEY=value into a bogus extra
 *    line, or inject an unintended var — F11) and no single quote (cannot be quoted
 *    identically for both parsers: shell needs `'\''`, compose ends the value there).
 * Unsafe entries are DROPPED with a loud warning, never emitted divergently (F12).
 */
function isEnvLineSafe(key: string, value: string): boolean {
  if (!ENV_KEY_RE.test(key)) {
    console.warn(`[services] dropping env entry whose key is not a valid identifier: ${JSON.stringify(key)}`);
    return false;
  }
  if (/[\r\n]/.test(value)) {
    console.warn(`[services] dropping env entry with a line break in its value: ${JSON.stringify(key)}`);
    return false;
  }
  if (value.includes("'")) {
    console.warn(`[services] dropping env entry with a single quote in its value (cannot be represented identically for compose --env-file AND shell sourcing): ${JSON.stringify(key)}`);
    return false;
  }
  return true;
}

/**
 * One `KEY='value'` line. Single quotes are literal for BOTH docker's env-file parser
 * and POSIX shell sourcing, so the containers and the agent see the same bytes (F12).
 */
function envLine(key: string, value: string): string {
  return `${key}='${value}'`;
}

/** Serialize the generated env file body (compose --env-file AND shell-sourceable). */
export function buildServicesEnvFile(args: {
  composeProjectName: string;
  ports: Record<string, number>;
  config: ServiceStackConfig;
  extraEnv?: Record<string, string>;
  /** Host the agent reaches services on; defaults to resolveServiceHost(). */
  serviceHost?: string;
}): string {
  const serviceHost = args.serviceHost ?? resolveServiceHost();
  const lines: string[] = [
    envLine("COMPOSE_PROJECT_NAME", args.composeProjectName),
    envLine("KANBAN_STACK", "1"),
  ];
  if (isEnvLineSafe("KANBAN_SERVICE_HOST", serviceHost)) {
    lines.push(envLine("KANBAN_SERVICE_HOST", serviceHost));
  }
  // Activate declared compose profiles (services behind a `profiles:` key). `up` runs with
  // NO `--profile` flag, so docker compose reads COMPOSE_PROFILES from this --env-file to
  // decide which profiles to enable. A profile name is dropped (with a warning) if it is not
  // a shell-safe env value; a comma is rejected here because it is the profile SEPARATOR
  // (an embedded comma would silently split into extra profiles). Absent/empty => default
  // (only unprofiled services start), so existing stacks are byte-identical to before.
  const profileNames = (args.config.profiles ?? [])
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (profileNames.length > 0) {
    const bad = profileNames.find((p) => p.includes(",") || !isEnvLineSafe("COMPOSE_PROFILES", p));
    if (bad !== undefined) {
      console.warn(`[services] dropping COMPOSE_PROFILES — profile name is not shell/comma-safe: ${JSON.stringify(bad)}`);
    } else {
      lines.push(envLine("COMPOSE_PROFILES", profileNames.join(",")));
    }
  }
  for (const [name, port] of Object.entries(args.ports)) {
    lines.push(envLine(portEnvVar(name), String(port)));
  }
  for (const [key, value] of Object.entries(args.config.env ?? {})) {
    if (isEnvLineSafe(key, value)) lines.push(envLine(key, value));
  }
  for (const [key, value] of Object.entries(args.extraEnv ?? {})) {
    if (isEnvLineSafe(key, value)) lines.push(envLine(key, value));
  }
  return lines.join("\n") + "\n";
}

/**
 * Best-effort diagnostic for merged SIBLING compose files (dev #109): scan each extra
 * `-f` compose file for a relative env_file/build-context/dockerfile/secret-or-config-
 * file/volumes-bind-mount path, because `docker compose -f <leading> -f <sibling>`
 * resolves those against the LEADING worktree (project directory = first `-f`), not the
 * sibling's own dir — a cryptic "file not found under <leading>" `up` failure. Logged
 * to the server console AND returned so the caller can attach it to the persisted
 * ServiceStackState + ticket-context (dev #162) — previously console.warn-only, so a
 * failure was undiagnosable outside the server log. Never throws; returns [] when
 * siblings use absolute or `${VAR}` paths (the common, working case).
 */
export async function lintSiblingComposeFiles(leadingWorktreePath: string, extraComposeFiles: string[]): Promise<string[]> {
  const warnings: string[] = [];
  for (const abs of extraComposeFiles) {
    let text: string;
    try {
      text = await readFile(abs, "utf-8");
    } catch {
      continue;
    }
    const issues = findSiblingComposeRelativePaths(text);
    const warning = siblingComposeRelativePathWarning({
      siblingName: basename(dirname(abs)),
      siblingComposeAbsPath: abs,
      leadingWorktreePath,
      issues,
    });
    if (warning) {
      console.warn(warning);
      warnings.push(warning);
    }
  }
  return warnings;
}
