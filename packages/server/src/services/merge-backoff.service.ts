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
import { projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getUncommittedTrackedChanges, revParse } from "./git.service.js";
import { getPreference } from "../repositories/preferences.repository.js";
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
 * Failure classes. The first two are NON-RETRYABLE-WITHOUT-CHANGE: no amount of retrying
 * fixes a dirty main checkout or a missing gradle distribution zip — only a human (or an
 * explicit state change) does, so they skip the gradual ramp and go straight to the cap.
 */
export type MergeFailureClass = "main_checkout_dirty" | "verify_infra_missing" | "generic";

export function isNonRetryableWithoutChange(cls: MergeFailureClass): boolean {
  return cls !== "generic";
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
  return cls === "main_checkout_dirty" || cls === "verify_infra_missing" ? cls : "generic";
}

/** Delay before the next allowed retry after `failures` identical failures. */
export function nextRetryDelayMs(cls: MergeFailureClass, failures: number): number {
  if (isNonRetryableWithoutChange(cls)) return MERGE_BACKOFF_CAP_MS;
  const doublings = Math.min(Math.max(failures, 1) - 1, 10);
  return Math.min(MERGE_BACKOFF_BASE_MS * 2 ** doublings, MERGE_BACKOFF_CAP_MS);
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

function makeDefaultIsMainCheckoutClean(database: Database) {
  return async (projectId: string): Promise<boolean | null> => {
    try {
      const [project] = await database.select({ repoPath: projects.repoPath }).from(projects)
        .where(eq(projects.id, projectId)).limit(1);
      if (!project?.repoPath) return null;
      const dirty = await getUncommittedTrackedChanges(project.repoPath);
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
    await database.update(workspaces).set({
      mergeBackoffFailures: 0,
      mergeBackoffSignature: null,
      mergeBackoffError: null,
      mergeBackoffBranchSha: null,
      mergeBackoffVerifyHash: null,
      mergeBackoffNextRetryAt: null,
      mergeBackoffSince: null,
    }).where(eq(workspaces.id, workspaceId));
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
  const [row] = await database.select({
    failures: workspaces.mergeBackoffFailures,
    signature: workspaces.mergeBackoffSignature,
    branchSha: workspaces.mergeBackoffBranchSha,
    verifyHash: workspaces.mergeBackoffVerifyHash,
    nextRetryAt: workspaces.mergeBackoffNextRetryAt,
  }).from(workspaces).where(eq(workspaces.id, ws.wsId)).limit(1);

  if (!row || !row.failures || !row.nextRetryAt) return { skip: false };
  if (now.toISOString() >= row.nextRetryAt) return { skip: false };

  const cls = failureClassFromSignature(row.signature);

  // Reset condition 1: a new commit landed on the branch — the failure may be fixed.
  if (ws.workingDir && row.branchSha) {
    const head = await (deps.getBranchHeadSha ?? defaultBranchHeadSha)(ws.workingDir);
    if (head && head !== row.branchSha) {
      await clearMergeBackoff(database, ws.wsId);
      return { skip: false, reason: "branch tip moved — backoff cleared" };
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

    const [row] = await database.select({
      failures: workspaces.mergeBackoffFailures,
      signature: workspaces.mergeBackoffSignature,
      since: workspaces.mergeBackoffSince,
    }).from(workspaces).where(eq(workspaces.id, ws.wsId)).limit(1);
    if (!row) return null;

    const identical = row.signature === signature;
    const failures = identical ? (row.failures ?? 0) + 1 : 1;
    const since = identical && row.since ? row.since : now.toISOString();
    const nextRetryAt = new Date(now.getTime() + nextRetryDelayMs(cls, failures)).toISOString();
    const branchSha = ws.workingDir ? await (deps.getBranchHeadSha ?? defaultBranchHeadSha)(ws.workingDir) : null;
    const verifyHash = await (deps.getVerifyScriptHash ?? makeDefaultVerifyScriptHash(database))(ws.projectId);

    await database.update(workspaces).set({
      mergeBackoffFailures: failures,
      mergeBackoffSignature: signature,
      mergeBackoffError: message.slice(0, 2000),
      mergeBackoffBranchSha: branchSha,
      mergeBackoffVerifyHash: verifyHash,
      mergeBackoffNextRetryAt: nextRetryAt,
      mergeBackoffSince: since,
      updatedAt: now.toISOString(),
    }).where(eq(workspaces.id, ws.wsId));

    // Surface the blocker ONCE, when the same failure has repeated (edge-triggered at the
    // threshold, mirroring #283's single obstacle at exhaustion — not one per cycle).
    const warned = failures === MERGE_BACKOFF_WARN_REPEATS;
    if (warned) {
      const summary = `Merges for workspace ${ws.wsId}${ws.issueNumber != null ? ` (#${ws.issueNumber})` : ""} blocked: ${cls} — identical failure ${failures}x since ${since}; retries backed off (next at ${nextRetryAt})`;
      await recordDriveObstacle({
        projectId: ws.projectId,
        kind: "merge_retry_blocked",
        severity: "warning",
        issueNumber: ws.issueNumber ?? null,
        summary,
        details: {
          workspaceId: ws.wsId,
          failureClass: cls,
          failures,
          since,
          nextRetryAt,
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
