// Placement-explanation types (#755), deliberately dependency-free.
//
// These live here rather than in `services/placement-explain.service.ts` because
// two consumers need the SHAPES without the service's graph: the renderer in
// `lib/placement-explanation-format.ts`, and `cli/commands/worker.ts` — which is
// also the entry point of the standalone worker binary, which "never opens or
// creates a database" (docs/worker-fleet.md §3).
//
// A type-only import is erased at build time, so runtime was never the problem.
// But `__tests__/worker-cli-isolation.test.ts` walks the import graph in SOURCE
// text on purpose, because that graph rots silently: today's `import type` from a
// service is tomorrow's value import, and nothing would notice. Importing the
// service for its types therefore counted as an edge and — transitively, via that
// service's `db/` and `repositories/` imports — broke the isolation guard.
//
// So the edge is INVERTED, which is the right direction anyway: the service owns
// the behaviour and imports its vocabulary from here, and the leaf consumers
// depend only on this file. Keep this module free of anything that reaches the db.
import type { ProviderName } from "../services/agent-provider/types.js";
import type { WorkerBuildFreshness } from "@agentic-kanban/shared/lib/worker-build-freshness";

/**
 * The chain's check ids, as DATA so the union and the runtime list cannot drift (#801).
 *
 * It was a hand-written union; recording a placement reason needs the same names at
 * runtime to narrow a free-text database column back to the vocabulary, and a second
 * hand-written list would be the drift this file's own guard neighbours exist to stop.
 * The ordering here is the chain's order, and `placement-chain-parity.test.ts` pins the
 * chain itself to `resolveWorkerPlacement`'s source order.
 */
export const PLACEMENT_CHECK_IDS = [
  "dispatch_opt_in",
  "profile_allowlist",
  "eligible_worker",
  "branch_for_transport",
  "project_repo_path",
  "repo_transport_shape",
] as const;

export type PlacementCheckId = (typeof PLACEMENT_CHECK_IDS)[number];

/**
 * What a recorded placement DECISION can name (#801).
 *
 * Every id is a check in the chain above, plus one that is not a check at all:
 * `resolver_error`, the catch-all host fallback `resolveWorkerPlacement` takes when the
 * resolution itself threw. Folding that into a check id would file a crash under whichever
 * step happened to be nearby, which is the kind of confidently-wrong record that sends the
 * next reader after the wrong bug.
 */
export type PlacementReasonId = PlacementCheckId | "resolver_error";

export const PLACEMENT_REASON_IDS: readonly PlacementReasonId[] = [
  ...PLACEMENT_CHECK_IDS,
  "resolver_error",
];

/**
 * Narrow a persisted `placement_reason` back to the vocabulary.
 *
 * The column is free text to SQLite, so a row written by an older build — or edited by
 * hand — must not be able to claim a reason id that does not exist. An unrecognised value
 * reads as "not recorded", which is the same thing a null means and the only honest answer.
 */
export function isPlacementReasonId(value: string | null | undefined): value is PlacementReasonId {
  return typeof value === "string" && (PLACEMENT_REASON_IDS as readonly string[]).includes(value);
}

/**
 * WHY a session was placed where it was, captured AT DISPATCH (#801).
 *
 * #755 answers "why is #N not dispatching right now" by re-running the chain against LIVE
 * state, and #774 records what the fleet looked like at the time — but neither captures the
 * resolver's own reasoning at the moment it decided, so "why did THAT session run on the
 * host three days ago" stayed unanswerable. A re-derivation cannot answer it: the prefs, the
 * fleet and the repo shape have all moved since. This is the one thing that has to be
 * WRITTEN when the decision is made rather than reconstructed afterwards.
 */
export interface PlacementReason {
  id: PlacementReasonId;
  /** One line an operator can act on, in the resolver's own wording. */
  detail: string;
}

export type PlacementCheckOutcome = "pass" | "skipped" | "decided" | "not-reached";

export type BranchSource = "workspace" | "assumed-feature-branch" | "none";

export type PlacementOutcome =
  | { kind: "remote"; workerId: string }
  | { kind: "host" }
  | { kind: "refused"; message: string };

export interface PlacementCheckResult {
  id: PlacementCheckId;
  docStep: number;
  title: string;
  outcome: PlacementCheckOutcome;
  /** One line an operator can act on. */
  detail: string;
  /** The values this check actually read, so nothing has to be taken on trust. */
  observed: Record<string, string | number | boolean | null>;
  /** Preference keys to change to make this check pass. */
  prefKeys: string[];
}

export interface WorkerEligibility {
  workerId: string;
  name: string;
  effectiveStatus: string;
  connected: boolean;
  load: number;
  maxConcurrency: number;
  sharesFilesystem: boolean;
  eligible: boolean;
  /** Why this worker is not a candidate — the first failing condition, or null. */
  ineligibleReason: string | null;
  /**
   * The identity fields below were added by #774 so `GET /api/workers` can be SERVED from
   * this shape instead of the raw `workers` row. The list route used to return the DB row
   * (no `connected`, no `load`), and the panel then computed "capacity" as the sum of
   * `maxConcurrency` over heartbeat-online workers — which is total capacity, not free
   * slots, and reads as free capacity even when every slot is busy. One shape, computed
   * once, is what stops those two answers from disagreeing.
   */
  os: string | null;
  arch: string | null;
  /** Parsed, not the raw JSON text the `workers` row stores. */
  labels: string[];
  providers: string[];
  status: string;
  lastHeartbeatAt: string | null;
  /** In-memory, from the last heartbeat (#754) — `undefined` = not heard from since boot. */
  protocolVersion?: number;
  workerVersion?: string;
  /**
   * #879: the reported build against the board's own package version. Present only when
   * the worker reported a build at all — an absent `workerVersion` stays a `?` at every
   * renderer, never "current". "behind-board" and "ahead-of-board" are deliberately
   * distinct words: ahead is a normal dev-machine state, not staleness. NON-BLOCKING —
   * refusal is `protocolVersion`'s job.
   */
  buildFreshness?: WorkerBuildFreshness;
  /** Sessions the board currently has assigned to this worker. `load` is its length. */
  assignedSessionIds: string[];
  /** Free slots on THIS worker: `maxConcurrency - load`, floored at 0. */
  freeSlots: number;
}

/**
 * The fleet as one computed shape (#774). `GET /api/workers`, the placement explanation and
 * the panel all read this, so "how many slots are actually free" has exactly one answer.
 */
export interface FleetSnapshot {
  registered: number;
  online: number;
  connected: number;
  /** Workers that pass every eligibility check for the resolved provider/labels. */
  eligible: number;
  /** REAL free slots across eligible workers — not the sum of `maxConcurrency`. */
  freeSlots: number;
  /** The provider eligibility was resolved for. */
  provider: ProviderName;
  /** `worker_labels_<projectId>`, when a project was named. */
  requiredLabels: string[];
  /**
   * #879: the board's OWN package version — what each row's `buildFreshness` compares
   * against, so renderers can say "behind board (board runs X)". Null when the board
   * cannot resolve its own manifest.
   */
  boardWorkerVersion: string | null;
  workers: WorkerEligibility[];
}

export interface PlacementExplanation {
  projectId: string;
  provider: ProviderName;
  /** `worker_dispatch_strict_<projectId>` — decides whether a failed check refuses or degrades. */
  strict: boolean;
  requiredLabels: string[];
  /** Where the branch used for check 4 came from: a real workspace, or a prediction. */
  branchSource: BranchSource;
  branch: string | null;
  chain: PlacementCheckResult[];
  /** The check that decided the outcome; null when the chain reached remote dispatch. */
  decidedBy: PlacementCheckId | null;
  /** What the chain concludes. */
  predicted: PlacementOutcome;
  /** What `resolveWorkerPlacement` actually answers for the same inputs (read-only dry run). */
  actual: PlacementOutcome;
  /**
   * False = this explanation's chain no longer matches the resolver it describes.
   * The resolver is the truth; treat the chain as the bug and say so loudly.
   */
  agreesWithResolver: boolean;
  fleet: FleetSnapshot;
  /** Single-sentence answer to "why was it not dispatched". */
  summary: string;
}

export interface SessionPlacementRecord {
  sessionId: string;
  workspaceId: string;
  branch: string | null;
  issueNumber: number | null;
  issueTitle: string | null;
  status: string;
  executor: string;
  startedAt: string;
  endedAt: string | null;
  placement: "remote" | "host";
  workerId: string | null;
  /** Null with a non-null workerId = the worker was revoked or removed since. */
  workerName: string | null;
  /**
   * The deciding check, as the resolver recorded it at dispatch (#801). Null for a session
   * placed before this was persisted, or one whose placement was passed in explicitly
   * rather than resolved — "not recorded" and "host by default" must stay distinguishable.
   */
  placementReason: PlacementReasonId | null;
  /** The resolver's wording for that decision. Null whenever `placementReason` is. */
  placementDetail: string | null;
}

export interface IssuePlacementReport {
  issue: { id: string; issueNumber: number; title: string; projectId: string };
  explanation: PlacementExplanation;
  /** What actually happened, for the sessions this issue has already run. */
  sessions: SessionPlacementRecord[];
}
