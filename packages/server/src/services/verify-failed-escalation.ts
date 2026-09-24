/**
 * What the auto-merge orchestrator does with ONE `verify_failed:` skip (#1230).
 *
 * MEASURED motivation (#1228, workspace 75b824fe): the pre-merge gate ran 31 times between
 * 22:47 and 06:49 UTC on the same commit, every run failing the same deterministic guard
 * (`function-nloc-ratchet`, "no listed function has grown"). ~3 min per run — arch 43 s,
 * typecheck 19 s, tests 118 s, plus the install preflight — so ~1.8 h of box time for zero
 * information. Three defects shared that loop, and this module is the seam that closes them
 * from the orchestrator's side:
 *
 *  1. **No backoff.** #1219 recorded a merge-backoff row for the skip but the orchestrator never
 *     CONSULTED it; every 30 s tick re-planned the whole candidate set. The row is now written
 *     under the `verify_failed` class (15 min, 30, 60, 2 h, 4 h cap) and
 *     `findCompletedWorkspaceRows` asks `shouldSkipMergeForBackoff` before a candidate is even
 *     considered. Signed on `<head sha>|<sorted failing suites>` rather than the message, so two
 *     runs of the same red gate are identical and a new commit is a fresh count by construction.
 *
 *  2. **A deterministic guard never trips anything.** The #1207 breaker only sees gate/train
 *     `error` outcomes, and a red verify is a `skipped`. A failure whose EVERY named suite is a
 *     guard/ratchet is deterministic on that commit, so after the SECOND identical one the
 *     workspace is taken out of the loop: its backoff is pinned at the attempt ceiling (waiting
 *     no longer resumes it — new work on the branch does), `readyForMerge` is cleared so the
 *     card reads as needing attention, a drive obstacle + butler event say so, and ONE issue
 *     comment names the failing suite(s). The comment goes through `insertIssueComment` — the
 *     single write path — whose identical-repeat collapse keeps a later repeat from spamming.
 *
 *  3. **The log line names the file(s).** `describeVerifyFailedSkip` is the one line the board
 *     log prints for the skip, so an operator does not have to open `%TEMP%\kanban-verify-<ws>.log`
 *     to learn which suite it was.
 *
 * Never throws: telemetry and backoff must not break the merge cycle they observe.
 */
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { Database } from "../db/index.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { clearWorkspaceReadyForMerge } from "../repositories/workspace-merge-prevalidation.repository.js";
import { getWorkspaceIssueContext } from "../repositories/workspace-reads.repository.js";
import { emitButlerSystemEvent } from "./butler-event-feed.js";
import { recordDriveObstacle, type ObstacleBroadcaster } from "./drive-obstacles.service.js";
import {
  defaultBranchHeadSha,
  exhaustMergeBackoff,
  recordMergeFailure,
  type MergeBackoffWorkspaceRef,
} from "./merge-backoff.service.js";
import { describeFailedSuites } from "./verify-failed-suites.js";

/** Identical guard failures on one commit before the workspace is taken out of the loop. */
export const DETERMINISTIC_GUARD_REPEATS = 2;

export interface VerifyFailedSkip {
  workspaceId: string;
  projectId: string;
  workingDir: string | null;
  issueNumber: number | null;
  /** The queue's `verify_failed: …` reason, verbatim. */
  reason: string;
  /** Repo-relative suites the gate blamed, when it could name them. */
  failedSuites?: string[];
  /** Every named suite is a guard/ratchet — deterministic on this commit. */
  guardFailure?: boolean;
}

export interface VerifyFailedEscalationDeps {
  database: Database;
  broadcast?: ObstacleBroadcaster;
  /** ISO clock for the persisted timestamps (repo convention). */
  now?: string;
  /** Injectable for tests; defaults to `git rev-parse HEAD` in the worktree. */
  getBranchHeadSha?: (workingDir: string) => Promise<string | null>;
}

export interface VerifyFailedEscalation {
  /** How many identical failures the backoff row now counts (null when nothing was recorded). */
  failures: number | null;
  /** True when this call took the workspace out of the loop (deterministic rule fired). */
  escalated: boolean;
}

/**
 * The failure's identity for the backoff signature (#1230): same commit + same suites ⇒ the
 * same failure. Falls back to the message when nothing was named — a compile error's tail is
 * still the best identity available.
 */
export function verifyFailedSignatureKey(headSha: string | null, failedSuites: readonly string[], reason: string): string {
  if (failedSuites.length === 0) return reason;
  return `verify_failed|${headSha ?? "?"}|${[...failedSuites].sort().join(",")}`;
}

/** The ONE board-log line for a `verify_failed:` skip — names the suites, not the tail. */
export function describeVerifyFailedSkip(skip: Pick<VerifyFailedSkip, "workspaceId" | "issueNumber" | "reason" | "failedSuites" | "guardFailure">): string {
  const who = `workspace ${skip.workspaceId}${skip.issueNumber != null ? ` (#${skip.issueNumber})` : ""}`;
  const files = skip.failedSuites ?? [];
  const named = describeFailedSuites({ files, guardFailure: skip.guardFailure === true });
  if (named) return `skipped ${who}: verify_failed — ${named}`;
  const firstLine = skip.reason.replace(/^verify_failed:\s*/i, "").split(/\r?\n/)[0]?.trim() ?? "";
  return `skipped ${who}: verify_failed — no failing suite could be named; ${firstLine.slice(0, 200)}`;
}

/** Is this the repeat that takes a deterministic failure out of the loop? Pure. */
export function shouldEscalateDeterministicFailure(input: { guardFailure: boolean; failures: number | null }): boolean {
  return input.guardFailure && (input.failures ?? 0) >= DETERMINISTIC_GUARD_REPEATS;
}

/**
 * Record the skip into the backoff, and on the second identical DETERMINISTIC failure take the
 * workspace out of the loop (see the module header). Returns what it did, for the caller's log.
 */
export async function escalateVerifyFailedSkip(
  skip: VerifyFailedSkip,
  deps: VerifyFailedEscalationDeps,
): Promise<VerifyFailedEscalation> {
  const { database } = deps;
  const now = deps.now ?? new Date().toISOString();
  const getHead = deps.getBranchHeadSha ?? defaultBranchHeadSha;
  const failedSuites = skip.failedSuites ?? [];
  const guardFailure = skip.guardFailure === true && failedSuites.length > 0;
  try {
    const headSha = skip.workingDir ? await getHead(skip.workingDir) : null;
    const ref: MergeBackoffWorkspaceRef = {
      wsId: skip.workspaceId,
      projectId: skip.projectId,
      workingDir: skip.workingDir,
      issueNumber: skip.issueNumber,
    };
    const recorded = await recordMergeFailure(ref, skip.reason, {
      database,
      now: () => new Date(now),
      broadcast: deps.broadcast,
      getBranchHeadSha: getHead,
      signatureKey: verifyFailedSignatureKey(headSha, failedSuites, skip.reason),
    });
    const failures = recorded?.failures ?? null;
    if (!shouldEscalateDeterministicFailure({ guardFailure, failures })) return { failures, escalated: false };

    await exhaustMergeBackoff(database, skip.workspaceId);
    await clearWorkspaceReadyForMerge(skip.workspaceId, now, database);
    const named = describeFailedSuites({ files: failedSuites, guardFailure: true });
    const summary =
      `Auto-merge stopped re-gating workspace ${skip.workspaceId}${skip.issueNumber != null ? ` (#${skip.issueNumber})` : ""}: ` +
      `${named} failed ${failures}x on the same commit${headSha ? ` (${headSha.slice(0, 8)})` : ""}. ` +
      "A guard/ratchet fails the same way every run, so the gate will not run again until the branch gains new work — " +
      "fix the guard failure and push, or land it by hand.";
    const workspace = await getWorkspaceIssueContext(skip.workspaceId, database).catch(() => undefined);
    if (workspace) {
      await insertIssueComment({
        issueId: workspace.issueId,
        workspaceId: skip.workspaceId,
        kind: "gate-decision",
        author: "system",
        body: summary,
        payload: { mergeReason: "deterministic_guard_failure", failedSuites, failures, headSha },
        createdAt: now,
      }, database);
    }
    await recordDriveObstacle({
      projectId: skip.projectId,
      kind: "merge_retry_blocked",
      severity: "critical",
      issueNumber: skip.issueNumber ?? null,
      summary,
      details: { workspaceId: skip.workspaceId, failureClass: "verify_failed", deterministic: true, failedSuites, failures, headSha },
    }, { database, broadcast: deps.broadcast });
    emitButlerSystemEvent({
      projectId: skip.projectId,
      kind: "merge_failed",
      workspaceId: skip.workspaceId,
      issueNumber: skip.issueNumber ?? undefined,
      text: summary,
    });
    console.warn(`[auto-merge] ${summary}`);
    return { failures, escalated: true };
  } catch (err) {
    console.warn(`[auto-merge] verify_failed escalation for ${skip.workspaceId} failed (non-fatal): ${errorMessage(err)}`);
    return { failures: null, escalated: false };
  }
}
