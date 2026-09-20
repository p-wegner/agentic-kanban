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
 * #1192 — a member's siding state (`workspace_train_siding`): how many times it was dropped
 * for a base conflict and sent a rebase turn, and whether it burned the cap and is now left
 * withheld. One row per workspace, gone once the branch moves or the member lands. Exposed
 * #1198 so the panel can say "on its 2nd siding" or "capped, withheld" instead of a bare
 * drop reason; the server's `TrainSidingRow` is an alias of this.
 */
export interface MergeTrainSidingDto {
  workspaceId: string;
  sidings: number;
  sidedBranchSha: string | null;
  conflictTrainTipSha: string | null;
  lastSidedAt: string | null;
  cappedAt: string | null;
}

/** `GET /api/merge-queue/trains?projectId=` — the project's train history plus its live sidings (#1198). */
export interface MergeTrainsResponse {
  ok: true;
  trains: MergeTrainRowDto[];
  /** Every member of this project currently on a siding (#1192). Empty when none is. */
  sidings: MergeTrainSidingDto[];
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
  /**
   * Members that could not be assembled. `deferred` (#1191, exposed #1197) marks the
   * member-vs-member case: the member collided with ANOTHER member, not with the base, and
   * waits for the next train rather than needing a rebase — the panel says so instead of
   * showing a bare drop reason. Absent on rows written before #1197.
   */
  dropped?: Array<{ workspaceId: string; reason: string; deferred?: true }>;
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
  /**
   * #1191 — connected components of the member-vs-member conflict graph computed while
   * assembling (deduped across bisect attempts). Members of one cluster collided with EACH
   * OTHER, not merely with the base: the input `group-scan` mode `train-conflicts` turns into
   * candidate `coupled_with` groups. Absent when no two members conflicted.
   */
  conflictClusters?: Array<{ workspaceIds: string[] }>;
  /**
   * #1193 — wall-clock milliseconds the train SAVED by gating bisect halves concurrently: the
   * sum of every attempt's gate duration minus the span those gates actually occupied together.
   * 0 (or absent, on rows written before #1193) when every gate ran one after another.
   */
  concurrentGateSavedMs?: number;
  /**
   * #1204 - the CONTROL ARM: what the gate said about the BARE BASE, measured once before a red
   * full train was bisected. `red` means the failure is on the base branch and nothing is
   * attributable to any member (no member is `gateRejected`, all stay ready); `green` means the
   * base was clean, so the bisect's attribution stands. Absent when no control arm ran (a green
   * train, an environment failure, a train too small to bisect, or a row written before #1204).
   */
  baseVerdict?: MergeTrainBaseVerdict;
}

/** #1204 - what the control-arm gate said about the bare base sha the train was assembled on. */
export type MergeTrainBaseVerdict = "red" | "green";

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
  /** Members that conflicted during assembly, with the conflict reason; `deferred` as on the evidence. */
  dropped: Array<{ workspaceId: string; reason: string; deferred?: true }>;
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
  /**
   * #1193 — labels of the sibling attempts whose gate window overlapped this one's in time,
   * i.e. the halves this node was gated CONCURRENTLY with. Absent when it gated alone. Set on
   * the final evidence write only (`buildTrainGateEvidence`), since the overlap is only known
   * once both halves have finished — a live row's appended nodes do not carry it yet.
   */
  concurrentWith?: string[];
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
