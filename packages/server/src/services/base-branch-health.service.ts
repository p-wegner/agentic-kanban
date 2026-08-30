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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { runUnderVerifyChainSemaphore } from "./verify-chain-semaphore.js";
// The base probe spawns the SAME verify script as the gate, so it inherits the board's
// listener pins the same way — and a phantom EADDRINUSE here is worse, because it is
// recorded as "the base is red" and then withholds every branch's merge.
import { VERIFY_NEUTRALIZED_LISTENER_ENV } from "../lib/verify-env.js";
import { cloneBranchTo, getMergeBase, revParse, isAncestor } from "@agentic-kanban/shared/lib/git-service";
import type { Database } from "../db/index.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { getProjectById } from "../repositories/project.repository.js";
import { VERIFY_SCRIPT_TIMEOUT_MS } from "./verify-budget.js";
import { resolveVerifyMaxWorkers } from "./pre-merge-gate.service.js";
import { failedSuitesForOutcome } from "./failed-suite-parse.js";
import { resolveEffectiveVerify, deriveSetupScriptFromProfile, getStackProfile } from "./stack-profile.service.js";
import {
  recordBaseBranchHealth,
  getLatestBaseBranchHealth,
  getBaseBranchHealthForSha,
  isBaseHealthAnswer,
  type BaseBranchHealthOutcome,
} from "../repositories/base-branch-health.repository.js";

// Re-exported so the attribution logic and its predicate read as one unit at the call sites
// that already import from this service (#935).
export { isBaseHealthAnswer };

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

/**
 * The longest a single probe can legitimately take: clone + install + verify, each at its own
 * ceiling. Two callers need this number and neither should re-derive it (#712):
 *
 *  - the sweep, to decide when a PERSISTED start stamp is stale enough to be an abandoned
 *    probe from a killed process rather than a live one, and
 *  - the sweep's due-predicate, to back a `timeout` outcome off by more than the probe's own
 *    runtime — `DEFAULT_INTERVAL_MS` (30 min) is LESS than the verify ceiling (45 min), so a
 *    permanently-timing-out project was due again the moment it finished timing out, i.e. it
 *    ran continuously.
 */
export const PROBE_MAX_DURATION_MS = CLONE_TIMEOUT_MS + INSTALL_TIMEOUT_MS + VERIFY_TIMEOUT_MS;

/**
 * Preference key holding the ISO time at which a probe for this project STARTED, cleared when
 * it finishes (#712).
 *
 * A preference rather than a column because the row this probe will eventually write is the
 * only other candidate, and writing a placeholder row would poison every consumer — they all
 * read the LATEST row and would see an in-progress marker as the base's current verdict. A
 * pref needs no migration and is invisible to those readers.
 *
 * `1ec5a2269e` drew the right lesson ("persisted recency is the only thing a restart cannot
 * forget") and applied it to the wrong END of the probe: it stamped completion only, so for
 * the entire 45–60 minutes a probe ran the persisted "last result" was the OLD one and every
 * `tsx watch` restart in that window launched a second full verify.
 */
export function baseHealthProbeStartPrefKey(projectId: string): string {
  return `base_health_probe_started_${projectId}`;
}

export interface BaseBranchVerifyResult {
  outcome: BaseBranchHealthOutcome;
  sha: string;
  branch: string;
  durationMs: number;
  message?: string;
  /**
   * The suites this run named as failed (#681 half B), parsed from the FULL output before
   * `tail()` throws 40 lines' worth away. `null` when the run could not speak about suites at
   * all — see `failedSuitesForOutcome`.
   */
  failedSuites?: string[] | null;
}

/**
 * Probes running RIGHT NOW in this process, keyed by project (#712).
 *
 * Two independent callers exist — the periodic sweep and a fire-and-forget `setImmediate`
 * after every merge — and neither knew about the other. With a deterministic temp dir that
 * meant probe B `rm -rf`'d probe A's tree mid-verify and A's `finally` then deleted B's; the
 * wreck was recorded by the outer catch as `outcome: "red"`, a FALSE RED that withholds every
 * merge on the project.
 *
 * The unique per-probe directory below makes a collision harmless. This map makes it not
 * happen: a second caller joins the running probe's promise instead of starting a rival run,
 * so a merge during a sweep costs nothing rather than two concurrent 45-minute verifies.
 */
const inFlightProbes = new Map<string, Promise<BaseBranchVerifyResult | null>>();

/** How many probes are currently running in this process — for tests and diagnostics. */
export function inFlightBaseBranchProbeCount(): number {
  return inFlightProbes.size;
}

/**
 * Run `verify_script` against the project's base branch at its CURRENT tip and persist the
 * result. Returns `null` when the project has no repo/base branch/verify_script configured —
 * a pure no-op, mirroring the pre-merge gate's own "nothing configured" behaviour.
 *
 * Concurrency-safe per project (#712): a call made while a probe for the same project is
 * already running JOINS it and returns its result rather than starting a second one.
 *
 * `now` is the ISO start time — it is PERSISTED (the in-flight start stamp), hence the `now?:
 * string` spelling rather than `nowMs`.
 */
export function verifyBaseBranchHealth(
  projectId: string,
  database: Database,
  now?: string,
): Promise<BaseBranchVerifyResult | null> {
  const running = inFlightProbes.get(projectId);
  if (running) return running;

  const probe = runBaseBranchProbe(projectId, database, now).finally(() => {
    inFlightProbes.delete(projectId);
  });
  inFlightProbes.set(projectId, probe);
  return probe;
}

async function runBaseBranchProbe(
  projectId: string,
  database: Database,
  now?: string,
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
  // #712 — a UNIQUE directory per probe. This used to be
  // `join(tmpdir(), \`kanban-base-health-${projectId}-${slug}\`)`: the same path every call,
  // `rm -rf`'d before the clone and again in `finally`. Two overlapping probes therefore
  // destroyed each other's working tree and the wreckage was recorded as a red base. The
  // in-flight map above should keep them from overlapping at all, but a lock is a policy and
  // this is the property: even if the lock is lost (two processes, a stale map, a future
  // caller that bypasses it), a collision is now impossible rather than merely unlikely.
  //
  // `mkdtemp` creates the unique PARENT; the clone goes into a `repo` child so `git clone`
  // still gets a non-existent destination, and the parent is what `finally` removes.
  const probeRoot = await mkdtemp(join(tmpdir(), `kanban-base-health-${slug}-`));
  const dest = join(probeRoot, "repo");
  const startedAt = Date.now();
  // Stamp the START, persisted, so a process restart mid-probe does not read the stale
  // previous RESULT and launch a rival verify (the restart storm `1ec5a2269e` aimed at).
  await setPreference(baseHealthProbeStartPrefKey(projectId), now ?? new Date().toISOString(), database)
    .catch(() => {});

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
    await cloneBranchTo(project.repoPath, branch, dest, CLONE_TIMEOUT_MS);
    if (installCommand) {
      const install = await runSetupScript(dest, installCommand, { timeoutMs: INSTALL_TIMEOUT_MS, env: { ...VERIFY_NEUTRALIZED_LISTENER_ENV } }).catch((e) => ({
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
    // #931: this probe runs the same verify script the gate does, on the same box, and had
    // no worker cap of its own — sharing the gate's resolved cap keeps the two from
    // independently defaulting to one vitest worker per core.
    const probeMaxWorkers = (await resolveVerifyMaxWorkers(projectId, database)).workers;
    // #949: and take the same one-at-a-time slot the gate's verify chain takes. #931 capped the
    // probe's WORKERS and made its scheduler decline to start while a gate held the build
    // semaphore, but that check is one-directional: once a probe was running, a gate arriving
    // afterwards acquired its chain slot immediately and ran a full suite alongside this one.
    // Two full suites on one box is the #949 symptom regardless of which started first, and
    // sharing a worker cap does not help when there are two of everything.
    let queueWaitMs = 0;
    const run = await runUnderVerifyChainSemaphore(
      () => runSetupScript(dest, verifyScript, {
        timeoutMs: VERIFY_TIMEOUT_MS,
        env: { ...VERIFY_NEUTRALIZED_LISTENER_ENV, KANBAN_TEST_MAX_WORKERS: String(probeMaxWorkers) },
      }).catch((e) => ({
        exitCode: 1,
        stdout: "",
        stderr: String(e),
        timedOut: false,
      })),
      `base-branch health probe for project ${projectId}`,
      (waited) => { queueWaitMs = waited; },
    );
    const durationMs = Date.now() - startedAt;
    // #949: `durationMs` spans clone + install + QUEUE WAIT + run, and the wait can now be
    // long. #935 reports the duration as provenance for a starved probe, so the wait has to be
    // named separately or that provenance becomes misleading in the other direction — a probe
    // that queued 40 minutes and then ran fine would read like a slow base.
    const queueNote = queueWaitMs > 0 ? ` (incl. ${Math.round(queueWaitMs / 1000)}s queued behind another verification)` : "";
    const combined = [run.stderr, run.stdout].filter(Boolean).join("\n").trim();
    if (run.timedOut) {
      result = {
        outcome: "timeout",
        sha,
        branch,
        durationMs,
        // #935 — provenance, so a starved probe is distinguishable from a genuinely slow base.
        // The observed failure was a 45-minute budget spent on a box where Windows Defender,
        // an unrelated Kotlin daemon and SearchIndexer had the cores and only 3 vitest workers
        // existed at all; the verdict recorded nothing that would have said so. A reader (or a
        // future heuristic) needs the budget and the worker cap the probe actually ran under.
        message: `verify_script timed out after ${VERIFY_TIMEOUT_MS}ms `
          + `(probe ran ${durationMs}ms${queueNote} with KANBAN_TEST_MAX_WORKERS=${probeMaxWorkers}). `
          + `This is NOT a verdict about the base: the probe could not answer, so the base's health is UNKNOWN.`,
        failedSuites: failedSuitesForOutcome("timeout", combined),
      };
    } else if (run.exitCode !== 0) {
      result = {
        outcome: "red",
        sha,
        branch,
        durationMs,
        message: tail(combined),
        // Parsed from the UNTAILED output (#681 half B): the failing-suite lines are scattered
        // through a vitest run, and the 40-line tail that becomes `message` routinely keeps
        // none of them.
        failedSuites: failedSuitesForOutcome("red", combined),
      };
    } else {
      result = { outcome: "green", sha, branch, durationMs, failedSuites: failedSuitesForOutcome("green", combined) };
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
    // Only ever this probe's OWN directory — the whole point of `mkdtemp` above.
    await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
    // Clear the in-flight stamp. An empty value reads as absent (see `isBaseHealthProbeDue`),
    // so no delete accessor is needed; and if this write is lost the stamp still expires after
    // `PROBE_MAX_DURATION_MS`, which is exactly the killed-process case.
    await setPreference(baseHealthProbeStartPrefKey(projectId), "", database).catch(() => {});
  }

  await recordBaseBranchHealth(
    {
      projectId,
      sha: result.sha,
      branch: result.branch,
      outcome: result.outcome,
      durationMs: result.durationMs,
      message: result.message,
      failedSuites: result.failedSuites,
    },
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
  /**
   * The sha `health` was actually recorded at — `health.sha` lifted to the top level so a
   * caller can render freshness without reaching into the row (and so it's still present
   * even if `health` itself later grows optional fields). Absent exactly when `health` is.
   */
  recordedSha?: string;
  /** How old `health` was at resolution time (`Date.now() - health.createdAt`, or the injected `nowMs`). */
  ageMs?: number;
}

/**
 * Resolve what's known about the base branch's health AT THE BRANCH'S MERGE-BASE — the state
 * the branch was actually built against, not whatever the base happens to be right now (which
 * may have moved since). Falls back to the latest known result for the project when the
 * merge-base sha itself was never verified (e.g. a scheduled/post-merge check runs less often
 * than commits land), so a caller can still say "the base was red as of the last check" rather
 * than nothing at all.
 *
 * The fallback is order-checked (#886): a `latest` row recorded at some sha A is only presented
 * when A is an ANCESTOR of the branch's merge-base — i.e. the branch was built at or after A. A
 * `latest` row can otherwise be OLDER than the branch (recorded before the base was rebased past
 * a fix, e.g. a red row at sha A that a later fix at sha B superseded, with the branch built on
 * B) — presenting it would put a stale, possibly-red verdict on a branch built past the fix. When
 * ancestry can't be confirmed, the result reports the health as unknown (`health: null`) rather
 * than risk a false red — a false red withholds every merge on the project, which is worse than
 * no answer.
 *
 * `nowMs` is epoch ms for the pure age arithmetic below (not persisted), hence the `nowMs?:
 * number` spelling rather than `now`.
 */
export async function getBaseBranchHealthAtMergeBase(
  projectId: string,
  workingDir: string,
  branchRef: string,
  baseRef: string,
  database: Database,
  nowMs?: number,
): Promise<BaseBranchHealthAtMergeBase> {
  const mergeBaseSha = await getMergeBase(workingDir, branchRef, baseRef);
  if (mergeBaseSha) {
    const atMergeBase = await getBaseBranchHealthForSha(projectId, mergeBaseSha, database);
    if (atMergeBase) {
      return {
        mergeBaseSha,
        health: atMergeBase,
        recordedSha: atMergeBase.sha,
        ageMs: ageMsOf(atMergeBase.createdAt, nowMs),
      };
    }
  }
  const latest = await getLatestBaseBranchHealth(projectId, database);
  if (latest && mergeBaseSha) {
    // Only present `latest` when it's actually an ancestor of (i.e. recorded at or before)
    // the branch's merge-base. `isAncestor` never throws, but wrap defensively anyway: a
    // git failure here must degrade to "unknown", never to presenting an unverified row as
    // this branch's health.
    const ancestor = await isAncestor(workingDir, latest.sha, mergeBaseSha).catch(() => false);
    if (!ancestor) return { mergeBaseSha, health: null };
  }
  return {
    mergeBaseSha,
    health: latest,
    recordedSha: latest?.sha,
    ageMs: latest ? ageMsOf(latest.createdAt, nowMs) : undefined,
  };
}

/** Pure age arithmetic (#886) — `nowMs?: number` per the repo's time-injection convention. */
function ageMsOf(createdAtIso: string, nowMs?: number): number {
  return (nowMs ?? Date.now()) - new Date(createdAtIso).getTime();
}

/** Render an age in ms as a short human string (`"45m"`, `"3h"`, `"2d"`). */
function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Build the attribution prefix for a branch gate failure message when the base was ALREADY red
 * at (or since) the branch's merge-base — so a branch gate failing on pre-existing rot reads as
 * such instead of training everyone to distrust the gate (#491's root-cause: an unattributed
 * failure is what let two genuinely-broken gates survive unnoticed).
 *
 * Returns `null` when there's nothing to attribute — no recorded base health, or the base was
 * green — leaving the caller's own message untouched.
 *
 * A NON-ANSWER (`timeout`/`unverified`) never produces an ALREADY-<outcome> accusation (#935);
 * it produces an explicitly-neutral note that says the base was not measured.
 */
export function describeRedBaseAttribution(info: BaseBranchHealthAtMergeBase): string | null {
  const { health, mergeBaseSha, ageMs } = info;
  if (!health || health.outcome === "green") return null;
  const ageNote = ageMs !== undefined ? `, checked ${formatAge(ageMs)} ago` : "";
  // A non-answer is an admission about the PROBE, not an accusation against the base. Saying
  // "BASE BRANCH ALREADY TIMEOUT"/"ALREADY UNVERIFIED" reads as the latter, and — worse — the
  // downstream readers of that verdict treat it as a red base: they suppress #638 fix-and-merge
  // routing and tell a genuinely-broken branch that "this failure may not be caused by this
  // branch". Both are wrong when the probe simply could not answer.
  if (!isBaseHealthAnswer(health.outcome)) {
    const what = health.outcome === "timeout"
      ? "the base-health probe TIMED OUT rather than returning a verdict"
      : "the base was never verified";
    return `BASE BRANCH HEALTH UNKNOWN (${health.sha.slice(0, 8)}${ageNote}) — ${what}, so this failure is NOT attributed to it. `
      + `Probe result: ${health.message ?? health.outcome}`;
  }
  const shaNote = mergeBaseSha && mergeBaseSha === health.sha
    ? `at the branch's merge-base (${health.sha.slice(0, 8)}${ageNote})`
    : `as of the last check (${health.sha.slice(0, 8)}${ageNote}${mergeBaseSha ? `, merge-base is ${mergeBaseSha.slice(0, 8)}` : ""})`;
  return `BASE BRANCH ALREADY ${health.outcome.toUpperCase()} ${shaNote} — this failure may not be caused by this branch. `
    + `Base verify result: ${health.message ?? `outcome ${health.outcome}`}`;
}
