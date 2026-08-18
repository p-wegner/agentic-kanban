/**
 * Exponential backoff / circuit breaker for monitor-driven merge + fix-and-merge retries (#417).
 *
 * Observed thrash: an eventhub workspace had fix-and-merge retried every ~9-10 minutes,
 * indefinitely, against two STATIC human-only blockers (main checkout dirty; verify-script
 * infrastructure missing). Each retry paid main-checkout git checks and a full Gradle
 * verify run inside the monitor cycle, and nothing surfaced the blockers to the operator.
 *
 * Mechanics (following the #283 review-preflight budget precedent — persisted on the
 * workspace row so a server restart does not reset the state):
 *  - Every monitor merge failure is classified and reduced to a SIGNATURE
 *    (`<failureClass>|<messageDigest>`, digits normalized so "1 uncommitted change" and
 *    "2 uncommitted changes" are the same blocker).
 *  - An IDENTICAL signature repeating doubles the retry interval per repeat
 *    (base 10 min, capped at 2 h). A different signature starts a fresh count.
 *  - Non-retryable-without-change classes — `main_checkout_dirty`,
 *    `verify_infra_missing` — go straight to the max backoff on the first failure:
 *    retrying cannot fix them, only a human can.
 *  - The block clears itself on any relevant state change, checked lazily when the
 *    monitor next considers the workspace: a new commit on the branch (tip moved), the
 *    main checkout became clean, or the verify script content changed.
 *  - After the same failure repeats >= MERGE_BACKOFF_WARN_REPEATS times, ONE
 *    `merge_retry_blocked` drive obstacle is recorded (edge-triggered, the same channel
 *    #283 uses) naming the workspace, the failure class, and since-when — so a human
 *    learns about the blocker without reading monitor logs.
 */
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getUncommittedTrackedChanges, revParse } from "./git.service.js";
import { gitExec } from "@agentic-kanban/shared/lib/git-exec";
import { getPreference } from "../repositories/preferences.repository.js";
import { getProjectRepoPath } from "../repositories/project.repository.js";
import {
  clearMergeBackoffState,
  getMergeBackoffSignatureState,
  getMergeBackoffState,
  setMergeBackoffState,
} from "../repositories/merge-backoff.repository.js";
import { verifyScriptPrefKey } from "./stack-profile.service.js";
import { recordDriveObstacle, type ObstacleBroadcaster } from "./drive-obstacles.service.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";

/** First retry delay once a failure has been seen (also the doubling base). */
export const MERGE_BACKOFF_BASE_MS = 10 * 60_000;
/** Ceiling on the retry interval (~2 h) — also the immediate delay for non-retryable classes. */
export const MERGE_BACKOFF_CAP_MS = 2 * 60 * 60_000;
/** Identical-failure count at which the blocker is surfaced as a drive obstacle. */
export const MERGE_BACKOFF_WARN_REPEATS = 2;
/**
 * First retry delay for a TIMEOUT (#649). A gate that ran out of time is the failure most
 * likely to repeat under the same load that caused it, so it starts three ramp steps up
 * instead of at the generic 10 minutes — retrying sooner mostly reproduces the timeout,
 * and each reproduction costs another full verify run inside the monitor cycle.
 */
export const MERGE_BACKOFF_TIMEOUT_BASE_MS = 40 * 60_000;
/**
 * Attempt ceiling per workspace+signature (#649). `MERGE_BACKOFF_WARN_REPEATS` only stops
 * WARNING — the retries themselves had no ceiling anywhere, so an unfixable branch could
 * keep buying attempts at the fix-and-merge escalation forever. At this count the block
 * stops expiring: only a substantive change to the branch (or one of the class-specific
 * reset conditions) resumes it, and a human is told once that it stopped.
 */
export const MERGE_BACKOFF_MAX_ATTEMPTS = 6;

/**
 * Failure classes. The first two are NON-RETRYABLE-WITHOUT-CHANGE: no amount of retrying
 * fixes a dirty main checkout or a missing gradle distribution zip — only a human (or an
 * explicit state change) does, so they skip the gradual ramp and go straight to the cap.
 */
export type MergeFailureClass =
  | "main_checkout_dirty"
  | "verify_infra_missing"
  | "verify_timeout"
  | "generic";

export function isNonRetryableWithoutChange(cls: MergeFailureClass): boolean {
  return cls === "main_checkout_dirty" || cls === "verify_infra_missing";
}

/** Classify a merge/fix-and-merge failure message into a backoff class. */
export function classifyMergeFailure(message: string): MergeFailureClass {
  if (/uncommitted tracked (?:source )?change/i.test(message)) return "main_checkout_dirty";
  // Verify-script INFRASTRUCTURE missing: the gate/verify output reports a file-not-found
  // (missing distribution zip, deleted script, absent tool) rather than a test failure.
  if (
    /(?:pre-merge gate failed|verify)/i.test(message) &&
    /(?:enoent|no such file|not found|could not find|cannot find|does not exist|nicht gefunden)/i.test(message)
  ) {
    return "verify_infra_missing";
  }
  // A gate that TIMED OUT is retryable — the next run may get a quieter box — but it is
  // the class most likely to repeat, so it gets its own ramp rather than sharing the
  // generic one. Checked after the infra pattern: a timeout waiting for a missing tool is
  // an infra problem first.
  if (/(?:pre-merge gate failed|verify|gate)/i.test(message) && /(?:timed? ?out|timeout|exceeded .*(?:time|budget))/i.test(message)) {
    return "verify_timeout";
  }
  return "generic";
}

/**
 * `<failureClass>|<sha1(normalized message)[:16]>` — the identity of a failing attempt.
 * Digits are normalized so counts ("1 uncommitted change" vs "2") don't fake a new failure.
 */
export function computeMergeFailureSignature(cls: MergeFailureClass, message: string): string {
  const normalized = message.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 500);
  return `${cls}|${createHash("sha1").update(normalized).digest("hex").slice(0, 16)}`;
}

export function failureClassFromSignature(signature: string | null): MergeFailureClass {
  const cls = signature?.split("|")[0];
  return cls === "main_checkout_dirty" || cls === "verify_infra_missing" || cls === "verify_timeout"
    ? cls
    : "generic";
}

/** Delay before the next allowed retry after `failures` identical failures. */
export function nextRetryDelayMs(cls: MergeFailureClass, failures: number): number {
  if (isNonRetryableWithoutChange(cls)) return MERGE_BACKOFF_CAP_MS;
  const base = cls === "verify_timeout" ? MERGE_BACKOFF_TIMEOUT_BASE_MS : MERGE_BACKOFF_BASE_MS;
  const doublings = Math.min(Math.max(failures, 1) - 1, 10);
  return Math.min(base * 2 ** doublings, MERGE_BACKOFF_CAP_MS);
}

/** True once this workspace+signature has burned its attempt ceiling (#649). */
export function attemptCeilingReached(failures: number | null | undefined): boolean {
  return (failures ?? 0) >= MERGE_BACKOFF_MAX_ATTEMPTS;
}

/** The workspace facts the backoff needs — a subset of the monitor's WorkspaceCandidate. */
export interface MergeBackoffWorkspaceRef {
  wsId: string;
  projectId: string;
  workingDir: string | null;
  issueNumber?: number | null;
}

export interface MergeBackoffDeps {
  database?: Database;
  /** Injectable clock (repo convention) — defaults to the real time. */
  now?: () => Date;
  /** Board broadcaster for the drive-obstacle event; optional (off-request callers omit it). */
  broadcast?: ObstacleBroadcaster;
  /** Probe seams for tests. Defaults hit git/prefs. */
  getBranchHeadSha?: (workingDir: string) => Promise<string | null>;
  /**
   * Did the branch gain real work since `sha`? true = yes, false = the tip moved but the
   * tree is identical, null = cannot tell (treated as yes — see the call site).
   */
  hasSubstantiveChangeSince?: (workingDir: string, sha: string) => Promise<boolean | null>;
  /** true = clean, false = dirty, null = unknown (keep the block on unknown). */
  isMainCheckoutClean?: (projectId: string) => Promise<boolean | null>;
  getVerifyScriptHash?: (projectId: string) => Promise<string | null>;
}

async function defaultBranchHeadSha(workingDir: string): Promise<string | null> {
  try {
    return (await revParse(workingDir, "HEAD")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * "Is the branch actually different?" — not just "did the tip move?" (#649).
 *
 * `git diff --quiet <sha> HEAD` exits 0 when the two trees are identical, which is exactly
 * the case an empty or purely-metadata commit produces. If the recorded sha is no longer
 * reachable (the branch was rebased, amended or reset) the diff cannot be computed; that
 * IS a real change to the branch, so it counts as substantive rather than as unknown.
 */
async function defaultHasSubstantiveChangeSince(workingDir: string, sha: string): Promise<boolean | null> {
  const res = await gitExec(["diff", "--quiet", sha, "HEAD"], { cwd: workingDir });
  if (res.code === 0) return false; // identical trees — the tip moved but nothing changed
  if (res.code === 1) return true; // differences present
  return null; // sha unreachable / git failed — the caller decides
}

function makeDefaultIsMainCheckoutClean(database: Database) {
  return async (projectId: string): Promise<boolean | null> => {
    try {
      const repoPath = await getProjectRepoPath(projectId, database);
      if (!repoPath) return null;
      const dirty = await getUncommittedTrackedChanges(repoPath);
      return dirty.length === 0;
    } catch {
      return null;
    }
  };
}

function makeDefaultVerifyScriptHash(database: Database) {
  return async (projectId: string): Promise<string | null> => {
    try {
      const script = await getPreference(verifyScriptPrefKey(projectId), database);
      if (!script || !script.trim()) return null;
      return createHash("sha1").update(script).digest("hex").slice(0, 16);
    } catch {
      return null;
    }
  };
}

/** Drop any merge backoff recorded for a workspace — on success or a relevant state change. */
export async function clearMergeBackoff(database: Database, workspaceId: string): Promise<void> {
  try {
    await clearMergeBackoffState(workspaceId, database);
  } catch (err) {
    console.warn(`[merge-backoff] could not clear backoff for ${workspaceId}:`, err instanceof Error ? err.message : err);
  }
}

export interface MergeBackoffSkipDecision {
  skip: boolean;
  /** Human-readable rationale, present when skipping or when a block was just cleared. */
  reason?: string;
}

/**
 * Whether the monitor should SKIP this workspace's merge attempt because an identical
 * failure is in its backoff window. Checked BEFORE the per-cycle merge slot is consumed
 * and before any expensive gate/verify work. While inside the window the reset conditions
 * are probed cheaply (one rev-parse; a git status only for the dirty-main class; a pref
 * read only for the verify class) — any relevant state change voids the block immediately
 * rather than waiting out the window.
 */
export async function shouldSkipMergeForBackoff(
  ws: MergeBackoffWorkspaceRef,
  deps: MergeBackoffDeps = {},
): Promise<MergeBackoffSkipDecision> {
  const database = deps.database ?? db;
  const now = (deps.now ?? (() => new Date()))();
  const row = await getMergeBackoffState(ws.wsId, database);

  if (!row || !row.failures || !row.nextRetryAt) return { skip: false };
  // #649: past the ceiling the window stops expiring. The reset conditions below still
  // run — a real fix must be able to resume the workspace — but simply waiting no longer
  // buys another attempt, which is what "circuit breaker" was supposed to mean.
  const exhausted = attemptCeilingReached(row.failures);
  if (!exhausted && now.toISOString() >= row.nextRetryAt) return { skip: false };

  const cls = failureClassFromSignature(row.signature);

  // Reset condition 1: the branch gained REAL work — the failure may be fixed.
  //
  // #649: this used to clear on "the tip differs from the recorded sha", which any commit
  // satisfies, `git commit --allow-empty` included. That made the circuit breaker
  // voidable at will: one empty commit reset the window and bought another shot at the
  // fix-and-merge escalation, at whatever the base cadence was. The tip must now differ
  // AND the tree must differ. A sha we can no longer diff against (rebase, amend, reset)
  // counts as changed — the branch really was rewritten.
  if (ws.workingDir && row.branchSha) {
    const head = await (deps.getBranchHeadSha ?? defaultBranchHeadSha)(ws.workingDir);
    if (head && head !== row.branchSha) {
      const substantive = await (deps.hasSubstantiveChangeSince ?? defaultHasSubstantiveChangeSince)(
        ws.workingDir,
        row.branchSha,
      );
      if (substantive !== false) {
        await clearMergeBackoff(database, ws.wsId);
        return { skip: false, reason: "branch gained new work — backoff cleared" };
      }
    }
  }
  // Reset condition 2: the main checkout became clean (the dirty-main blocker is gone).
  if (cls === "main_checkout_dirty") {
    const clean = await (deps.isMainCheckoutClean ?? makeDefaultIsMainCheckoutClean(database))(ws.projectId);
    if (clean === true) {
      await clearMergeBackoff(database, ws.wsId);
      return { skip: false, reason: "main checkout became clean — backoff cleared" };
    }
  }
  // Reset condition 3: the verify script content changed (infra may have been fixed).
  if (cls === "verify_infra_missing") {
    const hash = await (deps.getVerifyScriptHash ?? makeDefaultVerifyScriptHash(database))(ws.projectId);
    if (hash !== (row.verifyHash ?? null)) {
      await clearMergeBackoff(database, ws.wsId);
      return { skip: false, reason: "verify script changed — backoff cleared" };
    }
  }

  if (exhausted) {
    return {
      skip: true,
      reason:
        `merge retries exhausted (${cls}, ${row.failures} identical failure(s), ceiling ${MERGE_BACKOFF_MAX_ATTEMPTS}) — ` +
        "waiting no longer resumes them; new work on the branch does",
    };
  }
  return {
    skip: true,
    reason: `merge backoff active (${cls}, ${row.failures} identical failure(s), next retry at ${row.nextRetryAt})`,
  };
}

export interface RecordMergeFailureResult {
  failureClass: MergeFailureClass;
  failures: number;
  nextRetryAt: string;
  /** True when this call crossed the warn threshold and surfaced the drive obstacle. */
  warned: boolean;
}

/**
 * Record one monitor merge / fix-and-merge failure. Identical signature → count up and
 * double the window; new signature → fresh count. Never throws back into the merge path
 * (telemetry/backoff must not break the thing it observes).
 */
export async function recordMergeFailure(
  ws: MergeBackoffWorkspaceRef,
  message: string,
  deps: MergeBackoffDeps = {},
): Promise<RecordMergeFailureResult | null> {
  try {
    const database = deps.database ?? db;
    const now = (deps.now ?? (() => new Date()))();
    const cls = classifyMergeFailure(message);
    const signature = computeMergeFailureSignature(cls, message);

    const row = await getMergeBackoffSignatureState(ws.wsId, database);
    if (!row) return null;

    const identical = row.signature === signature;
    const failures = identical ? (row.failures ?? 0) + 1 : 1;
    const since = identical && row.since ? row.since : now.toISOString();
    const nextRetryAt = new Date(now.getTime() + nextRetryDelayMs(cls, failures)).toISOString();
    const branchSha = ws.workingDir ? await (deps.getBranchHeadSha ?? defaultBranchHeadSha)(ws.workingDir) : null;
    const verifyHash = await (deps.getVerifyScriptHash ?? makeDefaultVerifyScriptHash(database))(ws.projectId);

    await setMergeBackoffState(ws.wsId, {
      failures,
      signature,
      error: message.slice(0, 2000),
      branchSha,
      verifyHash,
      nextRetryAt,
      since,
      updatedAt: now.toISOString(),
    }, database);

    // Surface the blocker ONCE, when the same failure has repeated (edge-triggered at the
    // threshold, mirroring #283's single obstacle at exhaustion — not one per cycle).
    // Two edge-triggered obstacles, not one per cycle: a WARNING when the same failure has
    // repeated, and a CRITICAL at the ceiling — the second is the one that says the board has
    // stopped trying, which a human must not have to infer from a quiet log (#649).
    const ceilingReached = failures === MERGE_BACKOFF_MAX_ATTEMPTS;
    const warned = failures === MERGE_BACKOFF_WARN_REPEATS || ceilingReached;
    if (warned) {
      const summary = ceilingReached
        ? `Merges for workspace ${ws.wsId}${ws.issueNumber != null ? ` (#${ws.issueNumber})` : ""} GAVE UP: ${cls} — identical failure ${failures}x since ${since}; the retry ceiling (${MERGE_BACKOFF_MAX_ATTEMPTS}) is reached, so waiting will not resume it — push a fix to the branch or land it by hand`
        : `Merges for workspace ${ws.wsId}${ws.issueNumber != null ? ` (#${ws.issueNumber})` : ""} blocked: ${cls} — identical failure ${failures}x since ${since}; retries backed off (next at ${nextRetryAt})`;
      await recordDriveObstacle({
        projectId: ws.projectId,
        kind: "merge_retry_blocked",
        severity: ceilingReached ? "critical" : "warning",
        issueNumber: ws.issueNumber ?? null,
        summary,
        details: {
          workspaceId: ws.wsId,
          failureClass: cls,
          failures,
          since,
          nextRetryAt,
          ceilingReached,
          error: message.slice(0, 2000),
        },
      }, { database, broadcast: deps.broadcast });
      emitButlerSystemEvent({
        projectId: ws.projectId,
        kind: "merge_failed",
        workspaceId: ws.wsId,
        issueNumber: ws.issueNumber ?? undefined,
        text: summary,
      });
      console.warn(`[merge-backoff] ${summary}`);
    }

    return { failureClass: cls, failures, nextRetryAt, warned };
  } catch (err) {
    console.warn(`[merge-backoff] could not record merge failure for ${ws.wsId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
