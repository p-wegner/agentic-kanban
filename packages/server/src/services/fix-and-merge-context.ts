/**
 * What a fix-and-merge agent is TOLD went wrong (#943).
 *
 * `POST /api/workspaces/:id/fix-and-merge` takes an OPTIONAL `mergeError` body field. A human
 * (or a skill, or the board UI) routing a withheld workspace to the escape hatch normally has
 * no reason to retype the failure — it is already recorded — so the body is empty and the
 * service used to substitute the literal string `"Unknown merge error"`. Measured on #935: the
 * pre-merge gate withheld the merge naming ONE red ratchet test, and the fix agent spent a full
 * ~10-minute cycle checking the working tree, confirming the branch fast-forwards, and reporting
 * exit 0 with no commits — because the one test that was actually red was never in its prompt.
 * Expensive AND quiet: the workspace looks handled.
 *
 * Both halves of that failure are recorded somewhere already. This module reads them back:
 *
 *  - **the in-memory merge job** ({@link getMergeJob}) — `job.error` is the exact message the
 *    last merge attempt failed with, and `job.reason` says whether it was the gate;
 *  - **the durable `merge-attempt` issue comment** the gate writes (`recordGateFailureNote`),
 *    whose payload carries `gateMessage` — and the gate message ends with
 *    `[full verify log: <path>]`, so the log path rides along for free.
 *
 * The comment is the fallback rather than the primary because the job is per-attempt and always
 * current, while a comment can be from an older run; but the comment SURVIVES a backend restart,
 * which the job map explicitly does not (see merge-job.service.ts's header). So: job first,
 * comment second, and `"Unknown merge error"` only when genuinely nothing is on record.
 */
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getLatestIssueCommentByKind } from "../repositories/issue-comments.repository.js";
import { getMergeJob } from "./merge-job.service.js";
import { PRE_MERGE_GATE_FAILURE_REASON } from "./workspace-merge-gate.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** The literal the service substituted when the caller supplied nothing — the #943 symptom. */
export const UNKNOWN_MERGE_ERROR = "Unknown merge error";

/**
 * How a fix-and-merge prompt should FRAME the failure. A red verify gate and a dirty working
 * tree need opposite instructions, and handing the gate's failure to the working-tree prompt is
 * how #638's ungated-merge bypass looked plausible in the first place.
 */
export type FixAndMergeFailureKind = "pre-merge-gate" | "merge" | "unknown";

export interface FixAndMergeFailureContext {
  /** The failure text to put in front of the agent. Never empty. */
  message: string;
  kind: FixAndMergeFailureKind;
  /** Where the message came from, for the log line and the timeline payload. */
  source: "caller" | "merge-job" | "gate-comment" | "none";
  /** The full verify log path, when the message named one. */
  verifyLogPath: string | null;
}

/** The `[full verify log: <path>]` trailer `summarizeVerifyFailure` appends. */
const VERIFY_LOG_TRAILER = /\[full verify log:\s*([^\]]+)\]/i;

/** Pull the verify-log path out of a gate message, if it carries one. */
export function extractVerifyLogPath(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = message.match(VERIFY_LOG_TRAILER);
  return match ? match[1].trim() : null;
}

/**
 * True when the caller supplied nothing usable — an absent body field, whitespace, or the
 * placeholder itself echoed back by a client that read it off `merge-status`.
 */
function callerSuppliedNothing(mergeError: string | undefined): boolean {
  const trimmed = mergeError?.trim();
  return !trimmed || trimmed === UNKNOWN_MERGE_ERROR;
}

/** Does this message read like the pre-merge gate withhold? */
function looksLikeGateFailure(message: string): boolean {
  return /pre-merge gate failed/i.test(message) || /merge withheld/i.test(message);
}

/**
 * Resolve the failure a fix-and-merge session should be told about.
 *
 * A caller-supplied message always wins — it is the most specific thing anyone knows, and the
 * monitor path passes the live error. Otherwise recover it from the record, job before comment.
 * Never throws: a broken read degrades to the old placeholder rather than refusing the fix.
 */
export async function resolveFixAndMergeFailureContext(
  args: {
    workspaceId: string;
    issueId: string | null;
    mergeError?: string;
    /** Test seam: the in-memory merge-job read. */
    readMergeJob?: typeof getMergeJob;
    /** Test seam: the durable gate-note read. */
    readLatestMergeAttempt?: typeof getLatestIssueCommentByKind;
  },
  database: Database = db,
): Promise<FixAndMergeFailureContext> {
  const { workspaceId, issueId, mergeError } = args;
  const readMergeJob = args.readMergeJob ?? getMergeJob;
  const readLatestMergeAttempt = args.readLatestMergeAttempt ?? getLatestIssueCommentByKind;

  if (!callerSuppliedNothing(mergeError)) {
    const message = mergeError!.trim();
    return {
      message,
      kind: looksLikeGateFailure(message) ? "pre-merge-gate" : "merge",
      source: "caller",
      verifyLogPath: extractVerifyLogPath(message),
    };
  }

  try {
    const job = readMergeJob(workspaceId);
    if (job?.error?.trim()) {
      const message = job.error.trim();
      return {
        message,
        kind:
          job.reason === PRE_MERGE_GATE_FAILURE_REASON || looksLikeGateFailure(message)
            ? "pre-merge-gate"
            : "merge",
        source: "merge-job",
        verifyLogPath: extractVerifyLogPath(message),
      };
    }
  } catch (err) {
    console.warn(
      `[fix-and-merge] merge-job lookup failed for workspace ${workspaceId} (non-fatal):`,
      errorMessage(err),
    );
  }

  if (issueId) {
    try {
      const latest = await readLatestMergeAttempt(issueId, "merge-attempt", database);
      const payload = latest?.payload
        ? (JSON.parse(latest.payload) as { mergeReason?: string; gateMessage?: string; gateStage?: string })
        : null;
      const gateMessage = payload?.gateMessage?.trim();
      if (payload?.mergeReason === PRE_MERGE_GATE_FAILURE_REASON && gateMessage) {
        const stage = payload.gateStage ? ` (${payload.gateStage})` : "";
        const message = `Pre-merge gate failed${stage} — merge withheld. ${gateMessage}`;
        return {
          message,
          kind: "pre-merge-gate",
          source: "gate-comment",
          verifyLogPath: extractVerifyLogPath(gateMessage),
        };
      }
    } catch (err) {
      console.warn(
        `[fix-and-merge] gate-note lookup failed for workspace ${workspaceId} (non-fatal):`,
        errorMessage(err),
      );
    }
  }

  return { message: UNKNOWN_MERGE_ERROR, kind: "unknown", source: "none", verifyLogPath: null };
}
