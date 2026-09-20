/**
 * Backfill the per-worktree `commit-msg` hook into workspaces that predate #1214.
 *
 * #976's hook was written to `<worktree>/.git/hooks/commit-msg`, which in a linked worktree is
 * a FILE, not a directory — so the install failed silently and NO builder worktree has ever
 * carried the BOM-stripping backstop. Fixing `installCommitMsgHook` only helps worktrees created
 * after it, and a live board carries dozens of workspaces that would otherwise keep committing
 * unguarded until they are recreated. This pass closes that gap without touching any of them
 * beyond the one file and the one per-worktree config key.
 *
 * Deliberately narrow:
 *  - DIRECT workspaces are skipped. Their "worktree" is the project's MAIN checkout, whose hooks
 *    belong to whoever set them up; a sweep must not install into a checkout a human operates.
 *  - A worktree that already resolves `core.hooksPath` to an existing `commit-msg` is left alone,
 *    so the pass is idempotent and re-installs nothing the operator or provisioning already put
 *    there.
 *  - Budgeted per pass, so a board with a large backlog of old worktrees spreads the git spawns
 *    over several passes instead of one burst.
 */
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { listHookBackfillCandidates } from "../repositories/commit-msg-hook-backfill.repository.js";
import { installCommitMsgHook } from "../services/commit-msg-hook.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

/** Hourly: the population only grows when a workspace is created, and creation installs its own. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** Git spawns per pass are bounded; an unfinished backfill simply continues next pass. */
const DEFAULT_MAX_PER_PASS = 25;

export interface CommitMsgHookBackfillResult {
  scanned: number;
  installed: number;
  alreadyPresent: number;
  /** Worktree path gone from disk, or git could not answer for it. */
  skipped: number;
  failed: number;
  /** True when the per-pass budget cut the pass short. */
  truncated: boolean;
}

export interface CommitMsgHookBackfillDeps {
  database?: Database;
  maxPerPass?: number;
}

/**
 * Does this worktree lack a hook git would actually run? `core.hooksPath` unset means git
 * resolves hooks from the COMMON dir, which a linked worktree does not own — so an unset value
 * is exactly the pre-#1214 state, whatever files happen to sit in the worktree.
 */
async function needsCommitMsgHook(worktreePath: string): Promise<boolean | null> {
  const configured = await gitExec(["config", "--get", "core.hooksPath"], { cwd: worktreePath });
  // `--get` exits 1 for an unset key, which is a legitimate answer, not a failure. A worktree
  // git cannot read at all answers null so the caller can count it as skipped rather than fixed.
  if (configured.code !== 0 && configured.code !== 1) return null;
  const value = configured.stdout.trim();
  if (!value) return true;
  return !existsSync(join(resolvePath(worktreePath, value), "commit-msg"));
}

/** One backfill pass. Never throws: a sweep that dies on one bad worktree repairs none of the rest. */
export async function reconcileCommitMsgHooks(
  deps: CommitMsgHookBackfillDeps = {},
): Promise<CommitMsgHookBackfillResult> {
  const maxPerPass = deps.maxPerPass ?? DEFAULT_MAX_PER_PASS;
  const result: CommitMsgHookBackfillResult = {
    scanned: 0, installed: 0, alreadyPresent: 0, skipped: 0, failed: 0, truncated: false,
  };

  // Persistence stays behind the repository (#715: startup/ has no boundary of its own).
  const rows = await listHookBackfillCandidates(deps.database);

  for (const row of rows) {
    const worktreePath = row.workingDir;
    if (!worktreePath || !existsSync(worktreePath)) {
      result.skipped += 1;
      continue;
    }
    if (result.installed + result.failed >= maxPerPass) {
      result.truncated = true;
      break;
    }
    result.scanned += 1;
    try {
      const needs = await needsCommitMsgHook(worktreePath);
      if (needs === null) {
        result.skipped += 1;
        continue;
      }
      if (!needs) {
        result.alreadyPresent += 1;
        continue;
      }
      const install = await installCommitMsgHook(worktreePath, { tddMode: Boolean(row.tddMode) });
      if (install.installed) result.installed += 1;
      else result.failed += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[commit-msg-hook-backfill] ${worktreePath}: ${errorMessage(err)}`);
    }
  }

  // One line per pass, and only when the pass DID something: a board whose worktrees are all
  // current would otherwise print an hourly "0 installed", which is how a log stops being read.
  if (result.installed > 0 || result.failed > 0) {
    console.log(
      `[commit-msg-hook-backfill] ${result.installed} installed, ${result.failed} failed, ` +
        `${result.alreadyPresent} already present, ${result.skipped} skipped of ${result.scanned} scanned` +
        (result.truncated ? " (budget reached — the rest follow next pass)" : ""),
    );
  }
  return result;
}

let activeBackfill: PeriodicSweepHandle | null = null;

export function stopCommitMsgHookBackfill(): void {
  activeBackfill?.stop();
  activeBackfill = null;
}

export function startCommitMsgHookBackfill(
  deps: CommitMsgHookBackfillDeps = {},
  intervalMs = DEFAULT_INTERVAL_MS,
): PeriodicSweepHandle {
  stopCommitMsgHookBackfill();
  activeBackfill = startPeriodicSweep({
    name: "commit-msg-hook-backfill",
    tick: () => reconcileCommitMsgHooks(deps),
    intervalMs,
  });
  return activeBackfill;
}
