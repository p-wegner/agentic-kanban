// Cold-clone build check (#792) — a deterministic, project-agnostic review gate.
//
// Generalizes the one-off `scripts/coldclone-build-check.sh` (used to prove #783)
// into a reusable gate the board runs at review time. It clones the workspace's
// COMMITTED branch into a fresh temp dir — no junctioned `node_modules`, no warm
// pnpm store, no untracked artifacts — then runs the stack profile's install +
// build. A non-zero exit means the branch builds in the (dependency-symlinked)
// worktree but breaks on a clean clone: the exact #783 class of failure that the
// in-worktree verify gate and the diff-only LLM review both miss.
//
// Opt-in per project via the `cold_clone_check_<projectId>` preference (a pure
// no-op when unset, mirroring the `verify_script` gate), so existing projects and
// the dev board are unaffected unless they switch it on.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import * as gitService from "./git.service.js";
import {
  deriveSetupScriptFromProfile,
  deriveVerifyScriptFromProfile,
  getStackProfile,
} from "./stack-profile.service.js";

/** Preference key gating the cold-clone build check for a project. */
export function coldCloneCheckPrefKey(projectId: string): string {
  return `cold_clone_check_${projectId}`;
}

/** A cold-clone check is enabled when its preference is the literal string "true". */
export async function isColdCloneCheckEnabled(projectId: string, database: Database): Promise<boolean> {
  const raw = await getPreference(coldCloneCheckPrefKey(projectId), database);
  return raw?.trim() === "true";
}

export interface ColdCloneCheckResult {
  /** Whether the cold clone built cleanly. A skipped/no-op check is `ok: true`. */
  ok: boolean;
  /** Resolved reason — useful for logging and board surfacing. */
  reason: "passed" | "build-failed" | "clone-failed" | "no-build-command" | "skipped";
  /** The exit code of the failing step (install or build), when applicable. */
  exitCode?: number;
  /** Captured stdout/stderr tail from the failing step, for the board comment. */
  output?: string;
  /** The command that failed (install or build), for diagnostics. */
  failedCommand?: string;
}

export interface ColdCloneCheckInput {
  /** Source repo to clone FROM — the project's main checkout, which has the branch. */
  repoPath: string;
  /** The workspace's committed branch to validate (must exist in `repoPath`). */
  branch: string;
}

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a cold-clone build check: clone `branch` from `repoPath` into a fresh temp
 * dir, run the stack profile's install + build, and report whether it built clean.
 *
 * Pure deterministic — no LLM, no DB writes. The stack profile (#786) is the source
 * of truth for install/build commands (falls back to marker-rule derivation). The
 * temp clone is always removed, even on failure.
 *
 * `runner` is injectable so tests can drive the install/build without a real shell;
 * `cloner`/`cleanup` likewise, so the clone + temp lifecycle is unit-testable.
 */
export async function runColdCloneBuildCheck(
  input: ColdCloneCheckInput,
  profile: Parameters<typeof deriveSetupScriptFromProfile>[0],
  deps: {
    runner?: (cwd: string, script: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    cloner?: (repoPath: string, branch: string, dest: string) => Promise<void>;
    cleanup?: (dest: string) => Promise<void>;
    /** Override the temp clone dir (deterministic for tests). */
    tmpDir?: string;
  } = {},
): Promise<ColdCloneCheckResult> {
  const run = deps.runner ?? runSetupScript;
  const clone = deps.cloner ?? defaultCloner;
  const cleanup = deps.cleanup ?? ((dest: string) => rm(dest, { recursive: true, force: true }));

  // The build command is the actual gate. If we can't derive one, there's nothing
  // to check — treat as a no-op pass rather than a failure (mirrors verify_script).
  const buildCommand = deriveVerifyScriptFromProfile(profile, input.repoPath).trim();
  if (!buildCommand) return { ok: true, reason: "no-build-command" };

  const installCommand = deriveSetupScriptFromProfile(profile, input.repoPath).trim();

  // A unique temp dir keyed by branch so parallel reviews don't collide. The branch
  // name is sanitized to a filesystem-safe slug (it can contain `/`).
  const slug = input.branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = deps.tmpDir ?? join(tmpdir(), `kanban-coldclone-${slug}-${input.repoPath.length}`);

  try {
    await cleanup(dest); // remove any stale clone from a prior run
    await clone(input.repoPath, input.branch, dest);
  } catch (e) {
    return { ok: false, reason: "clone-failed", output: e instanceof Error ? e.message : String(e) };
  }

  try {
    if (installCommand) {
      const installRes = await run(dest, installCommand).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
      if (installRes.exitCode !== 0) {
        return {
          ok: false,
          reason: "build-failed",
          exitCode: installRes.exitCode,
          failedCommand: installCommand,
          output: tail(installRes.stderr || installRes.stdout),
        };
      }
    }

    const buildRes = await run(dest, buildCommand).catch((e) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
    if (buildRes.exitCode !== 0) {
      return {
        ok: false,
        reason: "build-failed",
        exitCode: buildRes.exitCode,
        failedCommand: buildCommand,
        output: tail(buildRes.stderr || buildRes.stdout),
      };
    }

    return { ok: true, reason: "passed" };
  } finally {
    // Always reclaim the temp clone — best-effort, never throw out of cleanup.
    await cleanup(dest).catch(() => {});
  }
}

/** Read the persisted stack profile and run the check end-to-end for a workspace. */
export async function runColdCloneBuildCheckForProject(
  projectId: string,
  input: ColdCloneCheckInput,
  database: Database,
  deps?: Parameters<typeof runColdCloneBuildCheck>[2],
): Promise<ColdCloneCheckResult> {
  const profile = await getStackProfile(projectId, database);
  return runColdCloneBuildCheck(input, profile, deps);
}

/** Default cloner: a shallow single-branch clone into a fresh dir (no worktree, no warm deps). */
async function defaultCloner(repoPath: string, branch: string, dest: string): Promise<void> {
  await gitService.cloneBranchTo(repoPath, branch, dest, CLONE_TIMEOUT_MS);
}

/** Keep only the last ~40 lines of captured output so a board comment stays readable. */
function tail(text: string | undefined, lines = 40): string {
  if (!text) return "";
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}
