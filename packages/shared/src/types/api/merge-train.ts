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
