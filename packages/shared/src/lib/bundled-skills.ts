/**
 * Skills that ship WITH the package, as real directories on disk (#skill-bundle).
 *
 * The DB-seeded built-ins (`builtin-skills.ts`) are prompt STRINGS — fine for a one-file
 * SKILL.md, useless for a skill that carries a `references/` bundle, and impossible to link
 * to instead of copying. A bundled skill is a directory under `packages/server/skills/`, so
 * it can be **junctioned** into a user's agent-skill directories: one install, and every
 * `npm update` of the board updates what every agent reads, with no re-install step.
 *
 * Node-only (fs/os). Import via the deep path `@agentic-kanban/shared/lib/bundled-skills`,
 * never the client-reachable barrel.
 */
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillsDirOf } from "./agent-skill-files.js";

/** Directory name under the package that holds bundled skill directories. */
const BUNDLE_DIRNAME = "skills";

export interface BundledSkill {
  name: string;
  /** Absolute path to the skill's directory (the one holding SKILL.md). */
  dir: string;
  description: string;
  /** Short SHA the bundle was generated from, from the SKILL.md frontmatter. */
  commit: string | null;
}

export type InstallMode = "linked" | "copied";

export interface InstalledSkill {
  name: string;
  path: string;
  mode: InstallMode;
  /** Set when a junction was requested but could not be created (and a copy was made instead). */
  linkError?: string;
}

/**
 * Locate the bundled `skills/` directory.
 *
 * Three shapes have to resolve, which is why this walks rather than hardcoding an offset:
 * an npm install (this module is bundled into `packages/server/dist/cli/index.js`), a dev
 * run under tsx (`packages/shared/src/lib/…`), and a test (cwd anywhere in the repo).
 */
export function findBundledSkillsDir(): string | null {
  const starts = [dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = resolve(start);
    for (;;) {
      for (const candidate of [join(dir, BUNDLE_DIRNAME), join(dir, "packages", "server", BUNDLE_DIRNAME)]) {
        if (existsSync(join(candidate, "agentic-kanban", "SKILL.md"))) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Frontmatter fields this module cares about. Absent file or field → nulls, never a throw. */
async function readSkillMeta(skillMd: string): Promise<{ description: string; commit: string | null }> {
  let raw = "";
  try {
    raw = await readFile(skillMd, "utf-8");
  } catch {
    return { description: "", commit: null };
  }
  // CRLF-tolerant on purpose: this repo is Windows-first and its checkouts are CRLF.
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  const fields = block ? block[1] : "";
  const field = (key: string) => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(fields);
    return m ? m[1].trim() : "";
  };
  return { description: field("description"), commit: field("commit") || null };
}

/** Every skill directory in the bundle, sorted by name. */
export async function listBundledSkills(bundleDir = findBundledSkillsDir()): Promise<BundledSkill[]> {
  if (!bundleDir) return [];
  let entries: string[];
  try {
    entries = (await readdir(bundleDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name);
  } catch {
    return [];
  }
  const skills: BundledSkill[] = [];
  for (const name of entries.sort()) {
    const dir = join(bundleDir, name);
    const skillMd = join(dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const meta = await readSkillMeta(skillMd);
    skills.push({ name, dir, description: meta.description, commit: meta.commit });
  }
  return skills;
}

/**
 * Agent-skill directories belonging to the USER rather than a project.
 *
 * Claude Code reads `~/.claude/skills`, and a machine may carry several profiles
 * (`~/.claude-work`, `~/.claude-team`, …) which share nothing — a skill installed into one
 * is invisible to the others. Codex reads `~/.codex/skills`. All of them are returned so a
 * single `install-skill --user` reaches every agent the user actually runs.
 *
 * Only directories that ALREADY exist are reported: creating `~/.claude-whatever` for an
 * agent the user does not have installed would be litter.
 */
export async function discoverUserSkillRoots(home = homedir()): Promise<string[]> {
  const roots: string[] = [];
  let entries: string[] = [];
  try {
    entries = (await readdir(home, { withFileTypes: true }))
      .filter(e => e.isDirectory() || e.isSymbolicLink())
      .map(e => e.name);
  } catch {
    return roots;
  }
  for (const name of entries.sort()) {
    if (!/^\.claude/.test(name) && name !== ".codex") continue;
    roots.push(join(home, name, "skills"));
  }
  return roots;
}

async function isSameTarget(link: string, target: string): Promise<boolean> {
  try {
    return resolve(await realpath(link)) === resolve(await realpath(target));
  } catch {
    return false;
  }
}

/**
 * Install one bundled skill into `<skillsDir>/<name>`.
 *
 * `link: true` creates a junction (Windows) / directory symlink (POSIX) into the package, so
 * the installed skill tracks the package version with no re-install. It falls back to a copy
 * when linking is refused — an npx cache the user cannot link into, a filesystem without
 * symlink permission, a Windows account without Developer Mode. A copy is a worse but working
 * install, and `linkError` says so rather than failing the command.
 */
export async function installBundledSkill(
  skill: BundledSkill,
  skillsDir: string,
  opts: { link?: boolean } = {},
): Promise<InstalledSkill> {
  const link = opts.link !== false;
  const dest = join(skillsDir, skill.name);
  await mkdir(skillsDir, { recursive: true });

  // An existing install of ANY kind is replaced: a stale copy is exactly what this mechanism
  // exists to prevent, and a junction pointing at an old checkout is worse than no install.
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(dest);
  } catch { /* nothing there */ }

  if (existing?.isSymbolicLink() && link && await isSameTarget(dest, skill.dir)) {
    return { name: skill.name, path: dest, mode: "linked" };
  }
  if (existing) await rm(dest, { recursive: true, force: true });

  if (link) {
    try {
      await symlink(skill.dir, dest, process.platform === "win32" ? "junction" : "dir");
      return { name: skill.name, path: dest, mode: "linked" };
    } catch (err) {
      const linkError = err instanceof Error ? err.message : String(err);
      await cp(skill.dir, dest, { recursive: true });
      return { name: skill.name, path: dest, mode: "copied", linkError };
    }
  }

  await cp(skill.dir, dest, { recursive: true });
  return { name: skill.name, path: dest, mode: "copied" };
}

export type SkillInstallState =
  | { state: "absent" }
  | { state: "linked"; path: string }
  | { state: "current"; path: string; commit: string | null }
  | { state: "stale"; path: string; commit: string | null; bundledCommit: string | null };

/**
 * What is installed at `<skillsDir>/<name>`, relative to the bundle.
 *
 * A junction is reported as `linked` without comparing content — that is the whole point of
 * linking, and following it to diff would just re-derive "identical". A COPY is compared by
 * content, because a copy is what silently rots after an upgrade.
 */
export async function inspectInstalledSkill(skill: BundledSkill, skillsDir: string): Promise<SkillInstallState> {
  const dest = join(skillsDir, skill.name);
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(dest);
  } catch {
    return { state: "absent" };
  }
  if (stat.isSymbolicLink()) {
    return await isSameTarget(dest, skill.dir)
      ? { state: "linked", path: dest }
      : { state: "stale", path: dest, commit: null, bundledCommit: skill.commit };
  }
  const installed = await readSkillMeta(join(dest, "SKILL.md"));
  const same = await filesMatch(join(dest, "SKILL.md"), join(skill.dir, "SKILL.md"));
  return same
    ? { state: "current", path: dest, commit: installed.commit }
    : { state: "stale", path: dest, commit: installed.commit, bundledCommit: skill.commit };
}

async function filesMatch(a: string, b: string): Promise<boolean> {
  try {
    const [ca, cb] = await Promise.all([readFile(a, "utf-8"), readFile(b, "utf-8")]);
    return ca.replace(/\r\n/g, "\n") === cb.replace(/\r\n/g, "\n");
  } catch {
    return false;
  }
}

/** `<root>/.claude/skills` for a project root — the project-scoped install target. */
export function projectSkillsDir(projectRoot: string): string {
  return skillsDirOf(projectRoot);
}

/**
 * Decide which skills an install actually writes, for a request that may name skills and may
 * target the user's agent homes rather than a project.
 *
 * Two rules, both of which were easy to get wrong inline in the CLI action:
 *
 * 1. **A bundled directory wins over a same-named prompt-only skill.** It is the richer form of
 *    the same skill, and installing both would leave the loser's SKILL.md sitting there.
 * 2. **`--user` defaults to bundled only.** The prompt-only built-ins are per-project working
 *    prompts the board also materializes into worktrees itself; installing them machine-wide
 *    would offer every agent in every repo a review prompt written for one particular board.
 *    Naming one explicitly still installs it — the default is a scope choice, not a restriction.
 */
export function selectSkillsToInstall<B extends { name: string }, P extends { name: string }>(
  input: { bundled: readonly B[]; promptOnly: readonly P[]; names?: readonly string[]; user?: boolean },
): { bundled: B[]; promptOnly: P[] } {
  const bundledNames = new Set(input.bundled.map(s => s.name));
  const promptOnly = input.promptOnly.filter(s => !bundledNames.has(s.name));

  const names = input.names?.map(n => n.trim()).filter(Boolean) ?? [];
  if (names.length > 0) {
    const wanted = new Set(names);
    return {
      bundled: input.bundled.filter(s => wanted.has(s.name)),
      promptOnly: promptOnly.filter(s => wanted.has(s.name)),
    };
  }
  return { bundled: [...input.bundled], promptOnly: input.user ? [] : promptOnly };
}
