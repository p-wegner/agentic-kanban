/**
 * The per-cycle CONTEXT of monitor auto-start, and the per-issue gate chain both of its
 * loops run — extracted from `monitor-auto-start.ts` (#1021, plan item P3.2).
 *
 * `monitor-auto-start.ts` had grown past the 1000-line god-module ceiling
 * `scripts/check-god-modules.mjs` enforces, and the general architecture plan names its real
 * seams: the In-Progress backfill, the Todo pull, and the ordering/gating helpers those two
 * share. This module is that third seam. It holds nothing that decides WHICH loop runs —
 * only what both loops ask: what the cycle knows (`AutoStartCycle`), whether the host or the
 * fleet can take another start, and whether one candidate may start at all
 * (`evaluateStartCandidate`).
 *
 * Keeping it here rather than inside either loop is what lets the two loops stay independent
 * siblings: `monitor-todo-pull.ts` imports this module, `monitor-auto-start.ts` imports
 * both, and there is no import cycle in either direction.
 *
 * The persistence boundary (#715): this module takes its `Database` from the cycle (or as a
 * parameter) and never value-imports `drizzle-orm` — its reads live in
 * `repositories/auto-start.repository.ts`. Behaviour is unchanged: in production
 * `ctx.database` IS the `db` singleton these functions used to reach for directly.
 */
import type { Database } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { projectCanDispatch, hostOverflowHasFleetCapacity as defaultHasFleetOverflowCapacity } from "../services/worker-fleet.service.js";
import type { FleetHoldDetail, MachineSaturationDetail, StartHoldContext } from "./monitor-start-holds.js";
import { isMonitorEligibleIssue } from "../repositories/start-scoring.repository.js";
import { shouldDeferForContention, type BuildFileContentionGate } from "./monitor-file-contention.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import type { MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { SKIP_AUTO_START_TAG } from "../repositories/wip-capacity.repository.js";
import type { orderCandidatesByStartScore } from "./monitor-start-scoring.js";
import type { buildHarnessBudgetGate } from "./monitor-harness-budget.js";
import { hasSkipAutoStartTag as selectSkipAutoStartTag, selectIssueWorkspaceStates } from "../repositories/auto-start.repository.js";

/** Does this issue carry the `no-auto-start` tag (`SKIP_AUTO_START_TAG`)? */
export async function hasSkipAutoStartTag(issueId: string, database: Database): Promise<boolean> {
  return selectSkipAutoStartTag(issueId, SKIP_AUTO_START_TAG, database);
}

/**
 * Reasons the Backlog/Todo pull loop declined to start an otherwise-unblocked issue this
 * cycle. Tallied per project so a monitor-mode project that looks idle (#179) gets an
 * explained cause instead of silence — `dependency_unresolved` and "workspace already
 * open" are NOT tallied here because they are expected, self-explanatory states, not
 * surprises.
 */
export type AutoStartSkipReason =
  | "wip_cap"
  | "no_auto_start_tag"
  | "contention_gate"
  /**
   * A verify/build/smoke gate is running right now, so new builder STARTS are held for this
   * cycle (#581). Running agents are never touched — only the decision to add MORE load is
   * deferred. Measured: a gate at 6 workers competing with two builders failed three
   * real-git `mergeWorkspace` tests that pass in isolation, and the failure named a real
   * test with a plausible defect, so it cost a 55-minute gate plus two isolated re-runs to
   * classify as a flake. The monitor runs every few minutes, so the cost of holding is one
   * cycle of latency; the cost of not holding is a gate result nobody can trust.
   */
  | "verify_gate_running"
  | "cycle_start_cap"
  | "feature_type_excluded"
  /**
   * The project dispatches builders to fleet workers in STRICT mode (epic #184)
   * and no connected worker has free capacity. Skipping keeps the ticket queued
   * for a later cycle instead of quietly running it on the board host, which is
   * exactly what strict mode exists to prevent.
   */
  | "no_available_worker"
  /**
   * The issue already has a workspace with `mergedAt` set (its work landed on the base
   * branch) but the issue status never reached Done — the drift that let a hand-off drive
   * spawn a SECOND workspace for already-merged work (#190). Instead of starting a
   * duplicate, the issue is reconciled to Done here and no launch happens this cycle.
   */
  | "already_merged"
  /**
   * The issue is a PLUGIN-LOOP UNIT ticket whose workspace already merged, and the reopen-retry
   * path (#265) would have started a fresh workspace for it (#361).
   *
   * Measured on kassenbuch step-6: a unit that was merged (`cd4aae9`, `mergedAt` 20:06:58) AND
   * gate-approved (20:11:44) AND Done went back to In Progress at 20:18:22, got a whole second
   * workspace and branch (`…-skel-r2`, 20:22:16), and had both abandoned ~3 minutes later when the
   * ticket reverted to Done. Loop `openTickets` read 2 for 6m24s while `progress` reported that
   * same step `done`.
   *
   * Why declining is right regardless of WHAT set the status (still unproven, see the ticket): a
   * loop unit's identity is its `external_key`, and the loop's dedupe never re-plans a unit that
   * already has a ticket. So work done in a fresh workspace for that unit can never be represented
   * in the loop — while it inflates `openTickets`, the value the monitor gates advancing on, and
   * leaves a branch and a worktree behind. A loop that genuinely wants another pass at a subject
   * mints a FRESH unit id (a gate's "revise" action does exactly that); reopening the old ticket is
   * never how a loop asks for more work.
   */
  | "loop_unit_reopen_declined"
  /**
   * The board HOST is too tight on RAM/CPU to take another agent right now (#908,
   * `machine-capacity.ts`), and no eligible fleet worker can take the session instead (or
   * the project forbids the host fallback, `worker_dispatch_strict`). Deliberately NOT
   * named with "fleet" in it — `fleetHold` (#774/#801) already means the worker-fleet's
   * OWN hold (no worker registered/connected/eligible for a strict project), a completely
   * different cause with a completely different remedy. This reason means the opposite
   * problem: the fleet may be fine, but there is nowhere to put MORE work — the host is
   * full and either no worker exists to take the overflow or dispatch was never opted in.
   *
   * This is a PLACEMENT input, not a hard gate: a saturated host with a connected,
   * eligible worker does not skip at all — the session starts and lands on that worker
   * (recorded as `machine_saturated` on ITS OWN session row via `resolveWorkerPlacement`'s
   * `hostSaturated` parameter, a different write path from this skip tally). This skip
   * reason only fires when saturation actually stopped a start from happening this cycle.
   */
  | "machine_saturated"
  /**
   * Another AUTOMATIC starter already holds the per-issue auto-start claim and is provisioning a
   * workspace for this issue right now (#366).
   *
   * The workspace row and the move to In Progress land in one transaction at the END of
   * provisioning (80s to 8+ minutes), so the table-based "does this issue already have an open
   * workspace?" check that every starter used is blind for that whole window. Two starters both
   * read "no workspace" and both provisioned. Measured live, on a server that already carried the
   * first fix: kassenbuch #9 got two workspaces sharing ONE worktree and branch (two agents
   * writing the same files concurrently for ~5 minutes), and linklocker #3 got three rows across
   * two branch slugs, leaving two full agent runs stranded on an unmerged branch.
   *
   * This is not a failure and not a consumed WIP slot — the OTHER starter's launch is the one
   * that counts, so the cycle records the decline and moves on.
   */
  | "create_in_flight"
  /** #1021 — the harness budget is full; rationale and mechanics in `monitor-harness-budget.ts`. */
  | "harness_budget";

/**
 * #936: the two hold RECORDERS and their detail shapes live in `monitor-start-holds.ts`
 * — one cohesive concern (why a project's start was held, with the measured shape behind
 * the collapsed reason token). Re-exported so existing importers keep this path.
 */
export type { FleetHoldDetail, MachineSaturationDetail };

export interface AutoStartSkipInfo {
  issueNumbers: number[];
  reasonCounts: Partial<Record<AutoStartSkipReason, number>>;
  /** Present only when this project was held by the fleet gate this cycle. */
  fleetHold?: FleetHoldDetail;
  /** Present only when this project was held by `machine_saturated` this cycle (#908). */
  machineSaturation?: MachineSaturationDetail;
}
/**
 * The per-cycle collaborators BOTH auto-start loops need: the injected deps, the
 * cycle-scoped tallies (skips per project, starts per project), and the resolved
 * tunables. Threading ONE context instead of a dozen parameters is what lets
 * `runAutoStart` be the short orchestrator it now is (#802) — before that split it
 * was a single 59-branch function and the god-module gate's complexity ratchet was
 * red on master.
 */
export interface AutoStartCycle {
  prefMap: Map<string, string>;
  /** The connection the skip-attribution recorders read through (#715 persistence boundary). */
  database: Database;
  baseUrl: string;
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  isAutoDrivenProject: (projectId: string) => boolean;
  buildContentionGate: BuildFileContentionGate;
  canDispatch: typeof projectCanDispatch;
  hasFleetOverflowCapacity: typeof defaultHasFleetOverflowCapacity;
  orderStartCandidates: typeof orderCandidatesByStartScore; buildHarnessGate: typeof buildHarnessBudgetGate;
  skipInfo: Map<string, AutoStartSkipInfo>;
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason, count?: number) => void;
  /**
   * #919: record the reason PER ISSUE, so "why is #57 not running" is answerable in the issue
   * panel. `noteSkip` above stays the per-project tally the monitor status reports — it is
   * keyed by project and several of its reasons are project-wide holds with no single ticket
   * to blame, so it cannot answer the per-ticket question. Buffered for the whole cycle and
   * flushed once at the end (`persistAutoStartSkipReason`), rather than a write per skip: a
   * `wip_cap` hold can name every waiting ticket in a backlog.
   */
  noteIssueSkip: (issueId: string, reason: AutoStartSkipReason) => void;
  /** #919: an issue the monitor DID start this cycle — its stale skip record is cleared. */
  noteIssueStarted: (issueId: string) => void;
  tunablesFor: (projectId: string) => ReturnType<typeof resolveMonitorTunables>["tunables"];
  /**
   * The project's WIP target, through THE resolver (#919) rather than
   * `tunablesFor(...).activeAgentsTarget`. Both loops read this: the Bullseye alone was blind
   * to `wip_limit_<projectId>`, the pref the onboarding wizard writes — so a project pinned to
   * 2 by the wizard was run at the Bullseye's (or the default) 5 by the monitor while the
   * Dependency Waves panel, which DID read it, said 2.
   */
  wipLimitFor: (projectId: string) => number;
  startsRemaining: (projectId: string) => number;
  noteStart: (projectId: string) => void;
  /**
   * One machine-capacity read for the whole cycle (#908) — Tier 1 (`fleet snapshot --json`)
   * when reachable, degrading to Tier 0 (`os.freemem()`) otherwise. Cached rather than read
   * per project: a monitor cycle can iterate many projects, and Tier 1 spawns a process, so
   * re-reading it per project would multiply that spawn by the project count for an answer
   * that cannot have changed within the same cycle.
   */
  machineCapacity: MachineCapacitySnapshot;
}

/**
 * Is the HOST too tight to add another agent process right now (#908)? Delegates to the
 * snapshot's own normalized `hold` (Tier 1: `!verdict.canStartAnother`; Tier 0: the freemem
 * floor) rather than re-deriving from `headroomProcesses` — the fleet tool's
 * `canStartAnother` verdict can weigh signals (e.g. thrashing) that a bare process-headroom
 * count does not, so recomputing from a different field than `resolveMachineCapacity`
 * normalizes could disagree with it and silently decide on the wrong number.
 *
 * This function decides whether the host is full, NOT whether a start happens — that is
 * the placement-not-a-gate distinction the ticket draws. A saturated host still starts the
 * work when an eligible worker can take it; `resolveWorkerPlacement`'s own `hostSaturated`
 * flag (read fresh per launch via Tier 0, cheap enough to not need this cached snapshot)
 * is what steers such a launch there and records why.
 */
export function isHostSaturated(capacity: MachineCapacitySnapshot): boolean {
  return capacity.hold;
}

/**
 * Can this project's fleet absorb a start the host cannot take? The three callers (both `#908`
 * saturation checks and `#936`'s gate-quiesce placement input) had this wiring inlined.
 */
export function hasFleetOverflow(ctx: AutoStartCycle, projectId: string): Promise<boolean> {
  return ctx.hasFleetOverflowCapacity({ database: ctx.database, projectId, providerName: narrowProviderName(ctx.prefMap.get("provider")) });
}

/**
 * Adapt the cycle to the narrow slice `monitor-start-holds.ts` takes (#936). The detail
 * objects are attached through callbacks rather than by handing over `skipInfo`, so the
 * hold recorders never learn the tally map's shape — which is what keeps the dependency
 * one-way after the extraction.
 */
export function holdContext(ctx: AutoStartCycle): StartHoldContext {
  return {
    database: ctx.database,
    prefMap: ctx.prefMap,
    machineCapacity: ctx.machineCapacity,
    noteSkip: ctx.noteSkip,
    attachFleetHold: (projectId, detail) => {
      const info = ctx.skipInfo.get(projectId);
      if (info) info.fleetHold = detail;
    },
    attachMachineSaturation: (projectId, detail) => {
      const info = ctx.skipInfo.get(projectId);
      if (info) info.machineSaturation = detail;
    },
  };
}

export type ContentionGate = Awaited<ReturnType<BuildFileContentionGate>>;

/** The rows both loops select as start candidates — the shared subset the gates below read. */
export interface AutoStartCandidate {
  id: string;
  title: string;
  description: string | null;
  issueType: string | null;
  issueNumber: number | null;
  externalKey: string | null;
}
/**
 * Reconcile an issue whose work already landed (some workspace has `mergedAt` set) but
 * whose status is still non-terminal — instead of treating it as unstarted/backfillable
 * work and spawning a duplicate builder workspace for it (#190). Best-effort: a failure
 * here must not block the auto-start loop, so it only warns.
 */
async function reconcileStaleMergedIssue(
  projectId: string,
  issueId: string,
  issueNumber: number | null | undefined,
  boardEvents: ReturnType<typeof createBoardEvents>,
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason) => void,
  mergedAt: string | null,
  database: Database,
): Promise<{ reopenedAfterMerge: boolean }> {
  const label = issueNumber != null ? `#${issueNumber}` : issueId;
  try {
    // `mergedAt` makes this a CATCH-UP reconcile: a status that was changed AFTER the merge
    // is a deliberate reopen and must be left alone. Without it this sweep re-closed such a
    // ticket on EVERY cycle, silently undoing the operator.
    const { issueTransitioned, reopenedAfterMerge } = await reconcileMergedIssue({ database, issueId, projectId, mergedAt });
    if (reopenedAfterMerge) {
      // #265: the reopen is respected AND actionable. Previously this returned here and the
      // ticket sat in Todo forever on a monitor-driven project — the operator's reopen was
      // honoured but inert, needing a hand-made workspace. The caller now falls through to
      // the normal start path, which builds a FRESH branch (the merged one already contains
      // the landed work, so reusing it would give the agent nothing to do).
      console.log(`[monitor] Issue ${label} was reopened after its workspace merged — leaving its status alone and starting a fresh workspace for the reopened work`);
      return { reopenedAfterMerge: true };
    }
    if (issueTransitioned) {
      console.log(`[monitor] Reconciled issue ${label} to Done — its workspace was already merged but the issue status had not caught up; skipped starting a duplicate workspace (#190)`);
      boardEvents.broadcast(projectId, "board_changed");
    }
  } catch (err) {
    console.warn(`[monitor] Failed to reconcile already-merged issue ${label}:`, errorMessage(err));
  }
  noteSkip(projectId, issueNumber, "already_merged");
  return { reopenedAfterMerge: false };
}

/**
 * Branch for a reopen retry (#265). The deterministic `feature/ak-<N>-<slug>` name is already
 * taken by the merged workspace, so a retry needs its own — suffixed with the attempt number
 * derived from how many workspaces the issue already has. The old merged workspace is left
 * closed as history; nothing reuses or deletes it.
 */
export function reopenRetryBranch(branch: string, priorWorkspaceCount: number): string {
  return `${branch}-r${priorWorkspaceCount + 1}`;
}
/**
 * The per-issue gate chain shared by BOTH loops (#802): open workspace → already-merged
 * reconcile → plugin-loop reopen guard → monitor eligibility → `no-auto-start` tag →
 * file-contention gate. It was duplicated line-for-line inside the two loops, which is
 * why guarding only one of them (as #361 originally did) left the defect reachable by
 * the other; one function now IS both copies.
 *
 * The only difference between the call sites was whether the last three gates are tallied
 * as skip reasons — the Todo pull loop reports them, the In-Progress backfill loop does
 * not — so that is passed in as `noteGateSkip` (a no-op for the backfill loop) rather than
 * as a flag, keeping the two behaviours identical to what they were.
 */
export async function evaluateStartCandidate(args: {
  issue: AutoStartCandidate;
  /** Project the already-merged reconcile is attributed to (the issue's own project). */
  reconcileProjectId: string;
  /** Project the skip tallies are recorded against (the In Progress status's project). */
  skipProjectId: string;
  allowFeatureTypes: boolean;
  contentionGate: ContentionGate;
  boardEvents: ReturnType<typeof createBoardEvents>;
  noteSkip: AutoStartCycle["noteSkip"];
  noteGateSkip: (reason: AutoStartSkipReason) => void;
  /**
   * #919: records the reason on the ISSUE. Unlike `noteGateSkip` this is NOT a no-op for the
   * backfill loop — the per-project tally distinction (`noteGateSkip`'s reason for existing)
   * is about what the monitor status reports, whereas "why is #57 not running" has the same
   * answer whichever loop declined it, and answering it for only one of the two loops would
   * be exactly the half-fix #361 warns about above.
   */
  noteIssueSkip: AutoStartCycle["noteIssueSkip"];
  /** #715: the cycle's connection, so this chain owns no singleton of its own. */
  database: Database;
}): Promise<{ start: false } | { start: true; isReopenRetry: boolean; priorWorkspaceCount: number }> {
  const { issue, contentionGate, allowFeatureTypes, noteSkip, noteIssueSkip } = args;
  /** Tally against the project (loop-dependent) AND record against the issue (always). */
  const noteGateSkip = (reason: AutoStartSkipReason) => { args.noteGateSkip(reason); noteIssueSkip(issue.id, reason); };
  // Ticket group (#661): the membership subquery makes a MEMBER issue (with no workspace
  // row of its own — the group workspace is keyed by the lead) look exactly like an issue
  // with its own workspaces, so the open-workspace skip AND the already-merged reconcile
  // below cover group members with no extra query.
  const issueWorkspaces = await selectIssueWorkspaceStates(issue.id, args.database);
  if (issueWorkspaces.some((w) => w.status !== "closed")) return { start: false };
  const mergedWs = issueWorkspaces.find((w) => w.mergedAt != null);
  let isReopenRetry = false;
  if (mergedWs) {
    // #265: only a DELIBERATE reopen falls through to start again; a merged issue whose
    // status simply had not caught up is still reconciled and skipped as before.
    ({ reopenedAfterMerge: isReopenRetry } = await reconcileStaleMergedIssue(args.reconcileProjectId, issue.id, issue.issueNumber, args.boardEvents, noteSkip, mergedWs.mergedAt, args.database));
    if (!isReopenRetry) return { start: false };
    // #361 — but never for a plugin-loop unit. See `loop_unit_reopen_declined`.
    if (parsePluginLoopUnitKey(issue.externalKey)) {
      console.log(`[monitor] Declining reopen-retry for plugin-loop unit issue #${issue.issueNumber} — its workspace already merged and the loop cannot represent a second one (#361)`);
      noteSkip(args.skipProjectId, issue.issueNumber, "loop_unit_reopen_declined");
      noteIssueSkip(issue.id, "loop_unit_reopen_declined");
      return { start: false };
    }
  }
  if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) { noteGateSkip("feature_type_excluded"); return { start: false }; }
  if (await hasSkipAutoStartTag(issue.id, args.database)) { noteGateSkip("no_auto_start_tag"); return { start: false }; }
  if (shouldDeferForContention(contentionGate, issue.id, issue.issueNumber)) { noteGateSkip("contention_gate"); return { start: false }; }
  return { start: true, isReopenRetry, priorWorkspaceCount: issueWorkspaces.length };
}
