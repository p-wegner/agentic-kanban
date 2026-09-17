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
}
