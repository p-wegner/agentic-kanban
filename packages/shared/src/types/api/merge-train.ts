import type { MergeTrainState } from "../../schema/merge-trains.js";

export type { MergeTrainState };

/**
 * A persisted release train row (#906) — what `GET /api/merge-queue/trains` returns and what
 * the client's "Merge train" panel (`lib/mergeTrainSummary.ts`) derives its summary from.
 * Declared once here rather than separately in server (drizzle row) and client
 * (wire-dto-single-declaration.test.ts) — see `shared/src/schema/merge-trains.ts` for the
 * persisted shape this mirrors.
 */
export interface MergeTrainRowDto {
  id: string;
  projectId: string;
  label: string;
  memberWorkspaceIds: string;
  state: MergeTrainState;
  gateEvidence: string | null;
  bisectResult: string | null;
  reconciledReason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * The parsed shape of `MergeTrainRowDto.gateEvidence` (#906, #1184) — what `finishMergeTrain`
 * writes and what the client's "Merge train" panel derives its numbers from. Every list is
 * deduplicated by workspace id (#1184: a bisect re-assembles each sub-attempt from scratch and
 * used to re-record the same conflict per attempt — 13 members, 17 drops on train qmu4t981a),
 * and the counts are precomputed so a reader gets "gate runs per landed member" without
 * re-parsing the lists. All fields optional: rows written before #1184 carry only the first five.
 */
export interface MergeTrainGateEvidenceDto {
  gateRuns?: number;
  gateFailure?: string | null;
  landed?: string[];
  dropped?: Array<{ workspaceId: string; reason: string }>;
  mergeSha?: string | null;
  /** #1154 — members neither landed, dropped nor individually gate-rejected (an unattributed red batch). */
  unresolved?: string[];
  /** Members the train was asked to carry. */
  memberCount?: number;
  landedCount?: number;
  /** Distinct members dropped during assembly, however many attempts re-dropped them. */
  uniqueDroppedCount?: number;
  /** Distinct members a bisect individually proved red. */
  gateRejectedCount?: number;
  /** #1194 — members a train-scoped review attributed a blocking finding to. */
  sided?: Array<{ workspaceId: string; reason: string }>;
  /** Distinct members sided by a train review. */
  sidedCount?: number;
  /** #1194 — whether/how the train-scoped review ran on the top-level attempt. */
  review?: MergeTrainReviewEvidenceDto;
  /**
   * #1189 — every assemble → gate → land cycle the train ran, in the order they finished. The
   * bisect tree: `label` is the sub-label (`q1`, `q1a`, `q1ab`, …), so a child's label extends
   * its parent's by one letter. Appended AS EACH ATTEMPT FINISHES, so a live `gating` row
   * exposes partial progress; the final write carries the complete list.
   */
  attempts?: MergeTrainAttemptDto[];
}

/**
 * How one train attempt (#1189) ended. Only `red` blames code; `sided` blames a SPECIFIC
 * member's ticket (a train review's finding, #1194), not the batch; the other failures are
 * the train's.
 */
export type MergeTrainAttemptVerdict = "landed" | "red" | "assembly_empty" | "land_refused" | "env_failure" | "sided";

/** One node of a train's bisect tree (#1189) — one `runTrainAttempt`. */
export interface MergeTrainAttemptDto {
  /** The attempt's train label; a bisect child's label is its parent's plus `a`/`b`. */
  label: string;
  /** Workspace ids this attempt was asked to assemble. */
  members: string[];
  /** Workspace ids that assembled onto the train and were gated. */
  included: string[];
  /** Members that conflicted during assembly, with the conflict reason. */
  dropped: Array<{ workspaceId: string; reason: string }>;
  /** Null when no gate ran (`assembly_empty`). */
  gateStartedAt: string | null;
  gateFinishedAt: string | null;
  /** 0 or 1 — an attempt gates at most once; the tree's sum is the train's `gateRuns`. */
  gateRuns: 0 | 1;
  verdict: MergeTrainAttemptVerdict;
  /** The first 300 chars of the gate failure / refusal text, for any verdict but `landed`. */
  failureHead?: string;
  /** The base tip after landing, for `landed` only. */
  mergeSha?: string;
  /** #1194 — members this attempt's train review sided, with the blocking finding (first 300 chars). */
  sided?: Array<{ workspaceId: string; reason: string }>;
}

/**
 * #1194 — what the train-scoped review did on a finished train, persisted beside the gate
 * evidence. `skipped` names the posture that did not ask for one; `failed` is a review that
 * could not run (the train landed unreviewed and says so, rather than failing the gate for a
 * reviewer outage); `ran` carries the counts the panel shows.
 */
export type MergeTrainReviewEvidenceDto =
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "ran"; findingCount: number; blockingCount: number; sidedWorkspaceIds: string[]; blocking: boolean };
