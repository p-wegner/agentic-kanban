/**
 * Cross-worktree guard wiring audit + repair across every registered project (#391 part 2, #396).
 *
 * The #369 incident's root cause was not a missing guard — it was a guard that LOOKED installed.
 * `exp/eventhub-backend/.claude/settings.json` shipped `prevent-cross-worktree-writes.js` on disk
 * but never registered it as a hook, so 16 `Edit` calls and 1 `Write` into another worktree all
 * succeeded and the guard never ran once. A later audit found **9 of 20 registered projects** in
 * some version of that state, most of them missing the SHELL matcher specifically — which is the
 * exact vector the incident used (`cd <main checkout> && git commit`).
 *
 * `project-scaffold.ts` wires both matchers, but only ON REGISTRATION, so every project registered
 * before that fix stayed broken and nothing looked wrong. "Script present, hook entry absent" is
 * therefore the state worth failing loudly about: it is indistinguishable from "protected" at a
 * glance, and it is silent by construction.
 *
 * The audit is read-only; repair is `ensureHookScaffold`, which is idempotent and additive (it
 * appends missing hook entries and never overwrites a script or an existing array).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHookScaffold } from "./project-scaffold.js";

const GUARD_SCRIPT = "prevent-cross-worktree-writes.js";
/** The two matchers the guard must be registered on — write tools AND shell tools (#369). */
const WRITE_MATCHER_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const SHELL_MATCHER_TOOLS = ["Bash", "PowerShell"];

export interface HookWiringStatus {
  projectId: string;
  projectName: string;
  repoPath: string;
  /** The guard script exists in .claude/hooks/. */
  scriptPresent: boolean;
  /** A hook entry references the guard on a Write/Edit-style matcher. */
  wiredForWrites: boolean;
  /** A hook entry references the guard on a Bash/PowerShell matcher. */
  wiredForShell: boolean;
  /**
   * The dangerous state: the script is on disk (so it LOOKS installed) but at least one vector is
   * unregistered, so that vector is silently unguarded.
   */
  looksInstalledButIsNot: boolean;
}

interface SettingsHookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

/** Every `(matcher, command)` pair in a settings.json, flattened across events. */
function readHookEntries(settingsPath: string): { matcher: string; command: string }[] {
  if (!existsSync(settingsPath)) return [];
  let parsed: { hooks?: Record<string, SettingsHookEntry[]> };
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as typeof parsed;
  } catch {
    // A settings.json we cannot parse is, for our purposes, a settings.json with no wiring —
    // report it as unwired rather than crashing the sweep or (worse) assuming it is fine.
    return [];
  }
  const out: { matcher: string; command: string }[] = [];
  for (const entries of Object.values(parsed.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (typeof hook.command === "string") out.push({ matcher: entry.matcher ?? "", command: hook.command });
      }
    }
  }
  return out;
}

/** Audit one repo's guard wiring. Pure filesystem reads — safe to run anywhere. */
export function auditHookWiring(
  project: { id: string; name: string; repoPath: string },
): HookWiringStatus {
  const hooksDir = join(project.repoPath, ".claude", "hooks");
  const scriptPresent = existsSync(join(hooksDir, GUARD_SCRIPT));
  const entries = readHookEntries(join(project.repoPath, ".claude", "settings.json"))
    .filter((e) => e.command.includes(GUARD_SCRIPT));
  const wiredForWrites = entries.some((e) => WRITE_MATCHER_TOOLS.some((t) => e.matcher.includes(t)));
  const wiredForShell = entries.some((e) => SHELL_MATCHER_TOOLS.some((t) => e.matcher.includes(t)));
  return {
    projectId: project.id,
    projectName: project.name,
    repoPath: project.repoPath,
    scriptPresent,
    wiredForWrites,
    wiredForShell,
    looksInstalledButIsNot: scriptPresent && !(wiredForWrites && wiredForShell),
  };
}

export interface HookWiringSweepResult {
  checked: number;
  /** Projects whose guard was present but not registered on both matchers, before repair. */
  broken: HookWiringStatus[];
  /** Projects whose wiring this sweep actually repaired. */
  repaired: string[];
  /**
   * Projects with NO guard script at all — unprotected, but honestly so.
   *
   * Reported, deliberately NOT auto-repaired. These are projects registered before the scaffold
   * shipped the guard unconditionally (#216); installing a hook into someone's repo is a bigger,
   * more surprising act than appending a missing entry to wiring they already opted into, and it
   * is not what #391/#396 asked for. Re-registering the project (or any scaffold pass) installs
   * it. The distinction that matters is that this state LOOKS unprotected and is — unlike
   * `broken`, which looks protected and is not.
   */
  unguarded: string[];
}

/**
 * Audit every registered project, and optionally repair what is broken.
 *
 * Repair is deliberately narrow: `ensureHookScaffold` appends the missing hook entries (and writes
 * the guard script if absent). It never rewrites an existing settings.json array, so a project
 * with custom hooks keeps them.
 *
 * A repo path that no longer exists is skipped, not reported — an unregistered/moved project is a
 * different problem, and reporting it here would bury the finding this sweep exists for.
 */
export function sweepHookWiring(
  projects: { id: string; name: string; repoPath: string | null }[],
  opts: { repair?: boolean } = {},
): HookWiringSweepResult {
  const broken: HookWiringStatus[] = [];
  const repaired: string[] = [];
  const unguarded: string[] = [];
  let checked = 0;
  for (const project of projects) {
    if (!project.repoPath || !existsSync(project.repoPath)) continue;
    checked++;
    const status = auditHookWiring({ id: project.id, name: project.name, repoPath: project.repoPath });
    if (!status.scriptPresent) {
      unguarded.push(project.name);
      continue;
    }
    if (!status.looksInstalledButIsNot) continue;
    broken.push(status);
    if (!opts.repair) continue;
    try {
      ensureHookScaffold(project.repoPath);
      const after = auditHookWiring({ id: project.id, name: project.name, repoPath: project.repoPath });
      if (!after.looksInstalledButIsNot) repaired.push(project.name);
    } catch {
      /* repair is best-effort; the finding is already recorded in `broken` */
    }
  }
  return { checked, broken, repaired, unguarded };
}

/** One-line-per-project report for the server log. Empty array when everything is wired. */
export function formatHookWiringReport(result: HookWiringSweepResult): string[] {
  if (result.broken.length === 0) {
    return result.unguarded.length > 0
      ? [`[hook-audit] ${result.unguarded.length} of ${result.checked} project(s) have NO cross-worktree guard installed ` +
         `(unprotected, but not misleading — re-register or re-scaffold to install): ${result.unguarded.join(", ")}`]
      : [];
  }
  const lines = [
    `[hook-audit] ${result.broken.length} of ${result.checked} registered project(s) ship the cross-worktree guard ` +
    `WITHOUT registering it on every vector — it looks installed and does not run:`,
  ];
  for (const status of result.broken) {
    const missing = [
      status.wiredForWrites ? null : "Write|Edit|MultiEdit|NotebookEdit",
      status.wiredForShell ? null : "Bash|PowerShell",
    ].filter(Boolean).join(" + ");
    lines.push(`  ${status.projectName}: unregistered on ${missing}  (${status.repoPath})`);
  }
  if (result.repaired.length > 0) {
    lines.push(`[hook-audit] repaired: ${result.repaired.join(", ")}`);
  }
  const unrepaired = result.broken.length - result.repaired.length;
  if (unrepaired > 0) lines.push(`[hook-audit] ${unrepaired} still broken — repair did not take effect`);
  return lines;
}
