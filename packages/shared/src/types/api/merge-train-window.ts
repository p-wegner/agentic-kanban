/**
 * The merge-train batching window on the wire (#1186) — what `GET /api/merge-queue/window`
 * returns and what the departure-board UI will read. Declared once here (the
 * wire-dto-single-declaration rule); the persisted record it is projected from lives in
 * `server/services/merge-train-window-state.ts`, the pure verdict in
 * `server/services/merge-train-window.ts`.
 */

/** Why the window released its pending set as one train. */
export type MergeTrainWindowReleaseReason =
  | "max_size"
  | "max_wait"
  | "gate_busy_grace_elapsed"
  /** `POST /api/merge-queue/window/release` — an operator asked it to depart now. */
  | "operator_release";

/** Why the window is still holding its pending set. */
export type MergeTrainWindowHoldReason =
  | "accumulating"
  | "gate_busy"
  /** `POST /api/merge-queue/window/hold` — an operator held the door until `heldUntil`. */
  | "held"
  /** A train for this project is already `assembling`/`gating` (#1153); nothing departs until it finishes. */
  | "live_train";

export type MergeTrainWindowReason = MergeTrainWindowReleaseReason | MergeTrainWindowHoldReason;

/** The last verdict `decideMergeTrainRelease` gave — the same struct the orchestrator logs. */
export type MergeTrainWindowVerdictDto =
  | { release: true; reason: MergeTrainWindowReleaseReason }
  | { release: false; reason: MergeTrainWindowHoldReason };

/**
 * The per-project record persisted as the `train_window_<projectId>` preference. Written on
 * every orchestrator tick where it changes, restored on boot, cleared when the window releases.
 */
export interface PersistedMergeTrainWindow {
  /** Ready workspace ids currently held back. Empty only for a control-only record (a hold placed before anything was ready). */
  pendingIds: string[];
  /** ISO — when the FIRST member of the current pending set became ready; the max-wait clock runs from here. */
  firstSeenAt: string;
  lastVerdict: MergeTrainWindowVerdictDto;
  /** ISO — the tick that produced `lastVerdict`. */
  lastEvaluatedAt: string;
  /** ISO — operator hold: no release before this instant, whatever the size/wait say. */
  heldUntil?: string;
  /** ISO — operator "depart now": release on the next tick regardless of size/wait. */
  releaseRequestedAt?: string;
}

export interface MergeTrainWindowPendingMemberDto {
  workspaceId: string;
  issueNumber: number | null;
  issueTitle: string | null;
  /** ISO — when the workspace last changed state, i.e. became ready; null when the workspace row is gone. */
  readySince: string | null;
}

export interface MergeTrainWindowConfigDto {
  maxSize: number;
  maxWaitMs: number;
  /** True when size/wait came from the risk posture rather than the shipped defaults or an explicit pref. */
  fromPosture: boolean;
  postureLevel: string;
}

export interface MergeTrainWindowDto {
  projectId: string;
  pending: MergeTrainWindowPendingMemberDto[];
  firstSeenAt: string;
  config: MergeTrainWindowConfigDto;
  lastVerdict: MergeTrainWindowVerdictDto;
  lastEvaluatedAt: string;
  /** `firstSeenAt + maxWaitMs`, or null when `maxWaitMs` is 0 (no wait bound). */
  projectedDepartureAt: string | null;
  heldUntil: string | null;
  releaseRequestedAt: string | null;
  /** A train of this project already `assembling`/`gating`, or null. */
  liveTrainId: string | null;
}

export interface MergeTrainWindowResponse {
  ok: true;
  /** null when the project has no open window (nothing ready, nothing held). */
  window: MergeTrainWindowDto | null;
}
