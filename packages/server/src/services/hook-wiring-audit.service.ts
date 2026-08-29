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
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHookScaffold } from "./project-scaffold.js";

const GUARD_SCRIPT = "prevent-cross-worktree-writes.js";
/** The two matchers the guard must be registered on — write tools AND shell tools (#369). */
const WRITE_MATCHER_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const SHELL_MATCHER_TOOLS = ["Bash", "PowerShell"];

/**
 * The COLLAPSED form (#914): the shell vector is covered by `smart-hooks-runner.js PreToolUse`
 * running the guard IN-PROCESS, rather than by a third `Bash|PowerShell` entry of its own —
 * three node cold starts per shell call became one.
 *
 * The audit must recognize it or it would report every correctly-wired project as broken and
 * then "repair" it by appending back the entry the collapse removed, undoing #914 on every
 * sweep. The runner's own `IN_PROCESS_HOOKS` table plus its `smart-hooks-config.json`
 * PreToolUse list are what actually run the guard; a settings.json entry for the runner on a
 * shell matcher is the wiring that reaches them.
 */
const RUNNER_SHELL_COMMAND = /smart-hooks-runner\.js\s+PreToolUse/;

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

/**
 * Does the runner's own config list the cross-worktree guard as a PreToolUse check (#914)?
 *
 * This is the half that makes the collapsed form verifiable rather than assumed. An
 * unreadable or malformed config returns false, so an unparseable config reports the project
 * as unwired — the same fail-closed choice `readHookEntries` already makes, and the right
 * one: "we could not confirm the guard runs" must never read as "protected".
 */
function runnerRunsGuard(hooksDir: string): boolean {
  const configPath = join(hooksDir, "smart-hooks-config.json");
  if (!existsSync(configPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      hooks?: { PreToolUse?: { command?: string; enabled?: boolean }[] };
    };
    return (parsed.hooks?.PreToolUse ?? []).some(
      (check) => check.enabled !== false && typeof check.command === "string" && check.command.includes(GUARD_SCRIPT),
    );
  } catch {
    return false;
  }
}

/** Audit one repo's guard wiring. Pure filesystem reads — safe to run anywhere. */
export function auditHookWiring(
  project: { id: string; name: string; repoPath: string },
): HookWiringStatus {
  const hooksDir = join(project.repoPath, ".claude", "hooks");
  const scriptPresent = existsSync(join(hooksDir, GUARD_SCRIPT));
  const allEntries = readHookEntries(join(project.repoPath, ".claude", "settings.json"));
  const entries = allEntries.filter((e) => e.command.includes(GUARD_SCRIPT));
  const wiredForWrites = entries.some((e) => WRITE_MATCHER_TOOLS.some((t) => e.matcher.includes(t)));
  // Either the guard has its own shell entry (the pre-#914 form, still valid), or the runner
  // has one AND that runner's config actually lists the guard as a PreToolUse check. Both
  // halves are required: a runner entry alone proves nothing about whether the guard runs.
  const wiredForShell =
    entries.some((e) => SHELL_MATCHER_TOOLS.some((t) => e.matcher.includes(t))) ||
    (allEntries.some(
      (e) => RUNNER_SHELL_COMMAND.test(e.command) && SHELL_MATCHER_TOOLS.some((t) => e.matcher.includes(t)),
    ) &&
      runnerRunsGuard(hooksDir));
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

/** #592 — the shared pass core, plus this sweep's own outcome lists. */
export interface HookWiringSweepResult extends PassReport {
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
  opts: { repair?: boolean; log?: (message: string) => void } = {},
): HookWiringSweepResult {
  const log = opts.log ?? ((message: string) => console.warn(`[hook-audit] ${message}`));
  const broken: HookWiringStatus[] = [];
  const repaired: string[] = [];
  const unguarded: string[] = [];
  const report = emptyPassReport();
  for (const project of projects) {
    if (!project.repoPath || !existsSync(project.repoPath)) continue;
    report.scanned++;
    const status = auditHookWiring({ id: project.id, name: project.name, repoPath: project.repoPath });
    if (!status.scriptPresent) {
      unguarded.push(project.name);
      recordSkipped(report, project.id, "no guard script");
      continue;
    }
    if (!status.looksInstalledButIsNot) {
      recordSkipped(report, project.id, "correctly wired");
      continue;
    }
    broken.push(status);
    if (!opts.repair) {
      recordSkipped(report, project.id, "broken, repair not requested");
      continue;
    }
    try {
      ensureHookScaffold(project.repoPath);
      const after = auditHookWiring({ id: project.id, name: project.name, repoPath: project.repoPath });
      if (!after.looksInstalledButIsNot) {
        repaired.push(project.name);
        recordActed(report, project.id, "repaired");
      } else {
        recordSkipped(report, project.id, "repair did not take");
      }
    } catch {
      /* repair is best-effort; the finding is already recorded in `broken` */
    }
  }
  // UNCONDITIONAL, and inside the pass rather than in the formatter (#723). This sweep was the
  // fifth `PassReport` adopter and the one #689 missed: it built a full report and returned it,
  // while `formatHookWiringReport` returned `[]` for a clean run and never printed the body at
  // all. So a run in which EVERY candidate threw — `existsSync` racing a mount, a settings.json
  // read failing, `ensureHookScaffold` blowing up outside the narrow catch below — looked
  // byte-identical in the server log to a run where every project was correctly wired.
  //
  // The emission belongs to the pass, not to its formatter: the formatter's job is the
  // per-project findings a human acts on, and it is legitimately empty when there are none,
  // whereas the remainder must be stated whether or not there is anything to act on. Same shape
  // as `startup/worker-incoming-sweep.ts` and `startup/agent-session-registry-reaper.ts` after
  // #718 removed their `if (...)` guards — a `scanned 0` line IS the report, not noise. The tag
  // is applied by the default logger (#616), so an injected `log` must not add one.
  log(formatPassReportBody(report));
  return { ...report, broken, repaired, unguarded };
}

/**
 * One-line-per-project report for the server log: the FINDINGS, not the pass summary.
 *
 * Still empty when everything is wired, and that is now safe — `sweepHookWiring` emits the
 * `scanned / acted / skipped / unaccounted` body itself, unconditionally (#723). Do not move the
 * body back in here: these lines exist for a human to act on, an empty findings list is a real
 * answer, and a summary that only prints when something is wrong is the #689 defect.
 */
export function formatHookWiringReport(result: HookWiringSweepResult): string[] {
  if (result.broken.length === 0) {
    return result.unguarded.length > 0
      ? [`[hook-audit] ${result.unguarded.length} of ${result.scanned} project(s) have NO cross-worktree guard installed ` +
         `(unprotected, but not misleading — re-register or re-scaffold to install): ${result.unguarded.join(", ")}`]
      : [];
  }
  const lines = [
    `[hook-audit] ${result.broken.length} of ${result.scanned} registered project(s) ship the cross-worktree guard ` +
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
