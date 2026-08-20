// Base-branch health (#491) — answers "is the base branch green right now", a question
// nothing previously asked. The only thing that ever ran `verify_script` was a branch's own
// pre-merge gate, so rot already sitting on the base was silently charged to whichever
// innocent branch's gate happened to run next (measured: three master-side blockers, each
// costing a full gate run before anyone knew the branch was innocent).
//
// Mirrors the cold-clone-build-check pattern (#792): clone the base branch into a fresh temp
// dir (no warm deps, no junctioned node_modules, no interference with a live worktree) and run
// the SAME `verify_script` the pre-merge gate uses, so a red base and a red branch gate are
// directly comparable.

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { cloneBranchTo, getMergeBase, revParse } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./verify-budget.js";
import { resolveEffectiveVerify, deriveSetupScriptFromProfile, getStackProfile } from "./stack-profile.service.js";
import {
  recordBaseBranchHealth,
  getLatestBaseBranchHealth,
  getBaseBranchHealthForSha,
  type BaseBranchHealthOutcome,
} from "../repositories/base-branch-health.repository.js";

const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
// Measured on this repo (#674): the scoped verify alone reported 974s of tests, and the base
// probe additionally installs the clone first. At 20 minutes the probe timed out instead of
// answering, which is the same failure mode as the false red it replaced — a probe that never
// returns a verdict still leaves the gate attributing branch failures to an unknown base.
// The budget is now SHARED with the pre-merge gate (verify-budget.ts) — this file's own
// premise is that the two run the same script and are "directly comparable", which two
// different ceilings quietly made false.
const VERIFY_TIMEOUT_MS = VERIFY_SCRIPT_TIMEOUT_MS;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface BaseBranchVerifyResult {
  outcome: BaseBranchHealthOutcome;
  sha: string;
  branch: string;
  durationMs: number;
  message?: string;
}

/**
 * Run `verify_script` against the project's base branch at its CURRENT tip and persist the
 * result. Returns `null` when the project has no repo/base branch/verify_script configured —
 * a pure no-op, mirroring the pre-merge gate's own "nothing configured" behaviour.
 */
export async function verifyBaseBranchHealth(
  projectId: string,
  database: Database,
): Promise<BaseBranchVerifyResult | null> {
  const project = await getProjectById(projectId, database);
  if (!project?.repoPath || !project.defaultBranch) return null;

  // #551: the same resolver the gate asks, so base health measures the command the gate
  // will actually run — including the derived one on a project that never set an override.
  const effective = await resolveEffectiveVerify(projectId, database, { repoPath: project.repoPath }).catch(() => null);
  const verifyScript = effective?.command ?? null;
  if (!verifyScript) return null;

  const branch = project.defaultBranch;
  const sha = await revParse(project.repoPath, branch).catch(() => null);
  if (!sha) return null;

  const slug = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dest = join(tmpdir(), `kanban-base-health-${projectId}-${slug}`);
  const startedAt = Date.now();

  // #674: the clone must be INSTALLED before verify. "No warm deps" was meant to buy
  // cold-clone realism, but an UNINSTALLED clone is not a cold clone — it is a broken
  // tree. This repo's shared package only exists after a build (its `prepare` runs
  // `tsc` into dist/, which is gitignored), so every suite importing
  // `@agentic-kanban/shared/lib` failed here for want of an install and master was
  // recorded RED for 98s runs while it was green in a real checkout. A false red is
  // worse than no signal: the gate attributes branch failures to the base and withholds
  // EVERY merge on the project. cold-clone-build-check.service.ts (#792) had this right
  // all along — clone, then the profile's install, then the command under test.
  const installCommand = (deriveSetupScriptFromProfile(await getStackProfile(projectId, database), project.repoPath) || "").trim();

  let result: BaseBranchVerifyResult;
  try {
    await rm(dest, { recursive: true, force: true });
    await cloneBranchTo(project.repoPath, branch, dest, CLONE_TIMEOUT_MS);
    if (installCommand) {
      const install = await runSetupScript(dest, installCommand, { timeoutMs: INSTALL_TIMEOUT_MS }).catch((e) => ({
        exitCode: 1,
        stdout: "",
        stderr: String(e),
        timedOut: false,
      }));
      if (install.timedOut || install.exitCode !== 0) {
        // UNVERIFIED, not red: we never got far enough to learn anything about the base.
        const combined = [install.stderr, install.stdout].filter(Boolean).join("\n").trim();
        result = {
          outcome: "unverified",
          sha,
          branch,
          durationMs: Date.now() - startedAt,
          message: `could not prepare the base clone — \`${installCommand}\` ${install.timedOut ? `timed out after ${INSTALL_TIMEOUT_MS}ms` : `failed (exit ${install.exitCode})`}. `
            + `The base was NOT verified; this says nothing about whether it is green.
${tail(combined)}`,
        };
        await recordBaseBranchHealth(
          { projectId, sha: result.sha, branch: result.branch, outcome: result.outcome, durationMs: result.durationMs, message: result.message },
          database,
        );
        return result;
      }
    }
    const run = await runSetupScript(dest, verifyScript, { timeoutMs: VERIFY_TIMEOUT_MS }).catch((e) => ({
      exitCode: 1,
      stdout: "",
      stderr: String(e),
      timedOut: false,
    }));
    const durationMs = Date.now() - startedAt;
    if (run.timedOut) {
      result = { outcome: "timeout", sha, branch, durationMs, message: `verify_script timed out after ${VERIFY_TIMEOUT_MS}ms` };
    } else if (run.exitCode !== 0) {
      const combined = [run.stderr, run.stdout].filter(Boolean).join("\n").trim();
      result = { outcome: "red", sha, branch, durationMs, message: tail(combined) };
    } else {
      result = { outcome: "green", sha, branch, durationMs };
    }
  } catch (e) {
    result = {
      outcome: "red",
      sha,
      branch,
      durationMs: Date.now() - startedAt,
      message: `base-branch health check errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
  }

  await recordBaseBranchHealth(
    { projectId, sha: result.sha, branch: result.branch, outcome: result.outcome, durationMs: result.durationMs, message: result.message },
    database,
  );
  return result;
}

/** Keep only the last ~40 lines so a stored/rendered message stays readable. */
function tail(text: string, lines = 40): string {
  if (!text) return "";
  const arr = text.split(/\r?\n/);
  return arr.slice(Math.max(0, arr.length - lines)).join("\n");
}

export interface BaseBranchHealthAtMergeBase {
  /** The merge-base sha between the branch and the base, when resolvable. */
  mergeBaseSha?: string;
  /** The recorded health row for that sha, when one was ever recorded. */
  health: Awaited<ReturnType<typeof getBaseBranchHealthForSha>> | Awaited<ReturnType<typeof getLatestBaseBranchHealth>>;
}

/**
 * Resolve what's known about the base branch's health AT THE BRANCH'S MERGE-BASE — the state
 * the branch was actually built against, not whatever the base happens to be right now (which
 * may have moved since). Falls back to the latest known result for the project when the
 * merge-base sha itself was never verified (e.g. a scheduled/post-merge check runs less often
 * than commits land), so a caller can still say "the base was red as of the last check" rather
 * than nothing at all.
 */
export async function getBaseBranchHealthAtMergeBase(
  projectId: string,
  workingDir: string,
  branchRef: string,
  baseRef: string,
  database: Database,
): Promise<BaseBranchHealthAtMergeBase> {
  const mergeBaseSha = await getMergeBase(workingDir, branchRef, baseRef);
  if (mergeBaseSha) {
    const atMergeBase = await getBaseBranchHealthForSha(projectId, mergeBaseSha, database);
    if (atMergeBase) return { mergeBaseSha, health: atMergeBase };
  }
  const latest = await getLatestBaseBranchHealth(projectId, database);
  return { mergeBaseSha, health: latest };
}

/**
 * Build the attribution prefix for a branch gate failure message when the base was ALREADY red
 * at (or since) the branch's merge-base — so a branch gate failing on pre-existing rot reads as
 * such instead of training everyone to distrust the gate (#491's root-cause: an unattributed
 * failure is what let two genuinely-broken gates survive unnoticed).
 *
 * Returns `null` when there's nothing to attribute — no recorded base health, or the base was
 * green — leaving the caller's own message untouched.
 */
export function describeRedBaseAttribution(info: BaseBranchHealthAtMergeBase): string | null {
  const { health, mergeBaseSha } = info;
  if (!health || health.outcome === "green") return null;
  // "unverified" means the probe could not even prepare the clone (#674). Saying
  // "BASE BRANCH ALREADY UNVERIFIED" reads as an accusation against the base; it is
  // an admission about the probe, and the caller's own failure stands unattributed.
  if (health.outcome === "unverified") {
    return `BASE BRANCH HEALTH UNKNOWN (${health.sha.slice(0, 8)}) — the base was never verified, so this failure is NOT attributed to it. `
      + `Probe result: ${health.message ?? "unverified"}`;
  }
  const shaNote = mergeBaseSha && mergeBaseSha === health.sha
    ? `at the branch's merge-base (${health.sha.slice(0, 8)})`
    : `as of the last check (${health.sha.slice(0, 8)}${mergeBaseSha ? `, merge-base is ${mergeBaseSha.slice(0, 8)}` : ""})`;
  return `BASE BRANCH ALREADY ${health.outcome.toUpperCase()} ${shaNote} — this failure may not be caused by this branch. `
    + `Base verify result: ${health.message ?? `outcome ${health.outcome}`}`;
}
