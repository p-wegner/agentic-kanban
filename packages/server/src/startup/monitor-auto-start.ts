import { computeBlockerReadiness, isTerminalStatusIdView, suggestBranchName, type BlockerWorkspaceLanding } from "@agentic-kanban/shared";
import { drives, issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, or, sql, inArray } from "drizzle-orm";
import { resolveCoupledComponent } from "@agentic-kanban/shared/lib/dependency-graph";
import { MAX_TICKET_GROUP_SIZE, isAutoGroupEnabled } from "@agentic-kanban/shared/lib/ticket-group";
import { db } from "../db/index.js";
import { createBoardEvents } from "../services/board-events.js";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { reconcileMergedIssue } from "../services/merge-cleanup.service.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { narrowProviderName } from "../services/agent-provider.js";
import { projectCanDispatch, hostOverflowHasFleetCapacity as defaultHasFleetOverflowCapacity } from "../services/worker-fleet.service.js";
// #774 — the fleet shape behind a `no_available_worker` skip, so the reason is not a
// single collapsed token. Same computation `GET /api/workers` serves.
import { describeFleet } from "../services/placement-explain.service.js";
import { shouldQuiesceBuildersForGate } from "../services/gate-quiesce.js";
import { isMonitorEligibleIssue, monitorEligibleIssueSql } from "./monitor-eligibility.js";
import { buildFileContentionGate, shouldDeferForContention, type BuildFileContentionGate } from "./monitor-file-contention.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { resolveMachineCapacity, type MachineCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import {
  AUTO_START_WIP_STATUSES,
  SKIP_AUTO_START_TAG,
  activeWipPredicate,
  countActiveWip,
  countWipCapacity,
  type WipCapacitySnapshot,
} from "../repositories/wip-capacity.repository.js";

async function hasSkipAutoStartTag(issueId: string): Promise<boolean> {
  const rows = await db.select({ id: tags.id }).from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(eq(issueTags.issueId, issueId), eq(tags.name, SKIP_AUTO_START_TAG)))
    .limit(1);
  return rows.length > 0;
}

/**
 * A drive/epic META issue must NOT be auto-started as a builder (#824, #664). You don't *build* the
 * meta — its children are the buildable leaves; the meta is driven to Done by the drive lifecycle
 * once the children land. Auto-starting it spawns a stray builder workspace that drifts to In
 * Review and inflates WIP (starving real leaves). Two robust signals: (1) it's a first-class Drive
 * record's metaIssueId (#799), or (2) it is a parent of other issues via a parent_of/child_of edge.
 * (REST-seeded epics with neither still rely on the `no-auto-start` tag the drive skill applies.)
 */
export async function isDriveOrEpicMeta(issueId: string, database = db): Promise<boolean> {
  try {
    const driveRows = await database.select({ id: drives.id }).from(drives)
      .where(eq(drives.metaIssueId, issueId)).limit(1);
    if (driveRows.length > 0) return true;
    const childEdges = await database.select({ id: issueDependencies.id }).from(issueDependencies)
      .where(sql`(${issueDependencies.issueId} = ${issueId} AND ${issueDependencies.type} = 'parent_of') OR (${issueDependencies.dependsOnId} = ${issueId} AND ${issueDependencies.type} = 'child_of')`)
      .limit(1);
    return childEdges.length > 0;
  } catch {
    return false; // best-effort: a detection error must never block auto-start
  }
}

/**
 * SQL predicate that EXCLUDES drive/epic metas from the auto-start candidate query (#824). This is
 * the in-query enforcement of the same rule {@link isDriveOrEpicMeta} documents — applied as a WHERE
 * condition so a meta is never even a candidate (no per-issue query, no stray builder workspace).
 */
export function notDriveOrEpicMetaSql() {
  return sql`NOT EXISTS (SELECT 1 FROM ${drives} WHERE ${drives.metaIssueId} = ${issues.id})
    AND NOT EXISTS (SELECT 1 FROM ${issueDependencies} WHERE (${issueDependencies.issueId} = ${issues.id} AND ${issueDependencies.type} = 'parent_of') OR (${issueDependencies.dependsOnId} = ${issues.id} AND ${issueDependencies.type} = 'child_of'))`;
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
  | "create_in_flight";

/**
 * What the fleet looked like when a project's start was held for `no_available_worker`
 * (#774, remaining #755 item 6).
 *
 * Before this, the whole answer was the token `no_available_worker` in `reasonCounts` plus
 * a `[monitor]` console line — so an operator reading the monitor status could not tell
 * "nobody paired a worker" from "every slot is busy" from "the one worker's socket dropped",
 * and the three have completely different remedies. The console line was the only place the
 * resolver's own `reason` appeared, and console output is not part of any status payload.
 *
 * NOTE: nothing READS this yet. The two consumers — `monitor-setup.ts` (which assembles the
 * status payload from `runAutoStart`'s return) and `autodrive-stall-warning.service.ts` —
 * were not #774's files. Tracked as **#801**.
 */
export interface FleetHoldDetail {
  /** The resolver's own refusal wording, verbatim. */
  reason: string;
  registered: number;
  online: number;
  /** Online AND holding a live WebSocket — the pair that actually makes a worker pickable. */
  connected: number;
  eligible: number;
  freeSlots: number;
  /** Where to get the full ordered decision chain for a specific ticket. */
  explain: string;
}

/**
 * What the machine looked like when a project's start was held for `machine_saturated`
 * (#908). Mirrors `FleetHoldDetail`'s reasoning: the collapsed skip-reason token alone
 * cannot tell an operator "Tier 1 measured true thrashing" from "Tier 0's cheap freemem
 * floor tripped because Tier 1 was unavailable", and those have different remedies (wait
 * out the real load, vs. install/reach `fleet` for a sharper answer).
 */
export interface MachineSaturationDetail {
  /** Which tier answered: "1" when the `fleet` tool was reachable, "0" otherwise. */
  tier: "0" | "1";
  /** The capacity read's own wording. */
  reason: string;
  freeGb?: number | null;
  headroomProcesses?: number;
  thrashing?: string;
}

export interface AutoStartSkipInfo {
  issueNumbers: number[];
  reasonCounts: Partial<Record<AutoStartSkipReason, number>>;
  /** Present only when this project was held by the fleet gate this cycle. */
  fleetHold?: FleetHoldDetail;
  /** Present only when this project was held by `machine_saturated` this cycle (#908). */
  machineSaturation?: MachineSaturationDetail;
}

export interface AutoStartDeps {
  serverPort: number;
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: (action: MonitorActionName, workspaceId: string, issueId: string) => void;
  /**
   * Which projects this cycle may auto-start work for. The monitor passes a predicate
   * that is true when the global monitor is on (legacy behaviour, gated on
   * nudge_auto_start) OR the project has per-project hands-off mode enabled. This
   * replaces the old single global `nudge_auto_start` gate so a freshly-registered
   * project can drain its backlog without flipping a global switch.
   */
  allowProject: (projectId: string) => boolean;
  /**
   * Which projects have per-project hands-off (autodrive) mode explicitly enabled.
   * When true for a project, Backlog issues are treated as ready-to-start alongside
   * Todo issues — so new tickets created via UI/MCP/REST start without a manual
   * status promotion. Defaults to false (Backlog stays a triage area for non-driven projects).
   */
  isAutoDrivenProject?: (projectId: string) => boolean;
  /**
   * Builds the per-project shared-registration-file contention gate (#119).
   * Defaults to the real DB-backed builder, so production needs no wiring;
   * injectable so tests of unrelated auto-start logic can pass an open gate
   * instead of modelling this module's queries.
   */
  buildContentionGate?: BuildFileContentionGate;
  /**
   * Checks whether a strict worker-dispatch project has fleet capacity (epic #184).
   * Defaults to the real implementation, so production needs no wiring; injectable
   * for the same reason as `buildContentionGate` above — it reads preferences from
   * the DB, and suites that model `db.select` as an ORDERED mock chain would other-
   * wise have their sequence shifted by its reads. That desync is silent: it makes
   * "starts X" tests fail AND "does NOT start X" tests pass vacuously.
   */
  canDispatch?: typeof projectCanDispatch;
  /**
   * One machine-capacity read for the whole cycle (#908). Defaults to the real
   * `resolveMachineCapacity`, so production needs no wiring; injectable for the same
   * reason as `canDispatch` above — the real Tier 0 reads this MACHINE'S actual free
   * memory, which a shared dev/CI box cannot guarantee stays above the 2GB default floor,
   * and a suite that hit that floor would non-deterministically start calling
   * `hostOverflowHasFleetCapacity` (another `db.select` reader) and desync every ordered
   * mock chain in this file's other test suites.
   */
  readMachineCapacity?: typeof resolveMachineCapacity;
  /**
   * Can this project's fleet absorb overflow from a saturated host (#908)? Defaults to
   * the real implementation; injectable for the same ordered-mock-chain reason as
   * `canDispatch` — it reads preferences from the DB.
   */
  hostOverflowHasFleetCapacity?: typeof defaultHasFleetOverflowCapacity;
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
): Promise<{ reopenedAfterMerge: boolean }> {
  const label = issueNumber != null ? `#${issueNumber}` : issueId;
  try {
    // `mergedAt` makes this a CATCH-UP reconcile: a status that was changed AFTER the merge
    // is a deliberate reopen and must be left alone. Without it this sweep re-closed such a
    // ticket on EVERY cycle, silently undoing the operator.
    const { issueTransitioned, reopenedAfterMerge } = await reconcileMergedIssue({ database: db, issueId, projectId, mergedAt });
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
function reopenRetryBranch(branch: string, priorWorkspaceCount: number): string {
  return `${branch}-r${priorWorkspaceCount + 1}`;
}

/**
 * Ticket group (#661): pick the group MEMBERS to ride along when the monitor starts
 * `lead`. Membership is the lead's `coupled_with` connected component, restricted to
 * candidates that are themselves independently startable — same status pool, monitor-
 * eligible, untagged, uncontended, dependency-unblocked, with no workspace history.
 * Anything that fails a check is simply left for a later cycle; grouping must never
 * start a ticket the per-issue gates would have refused.
 */
async function resolveAutoStartGroupMembers(args: {
  lead: { id: string; issueNumber: number | null };
  candidates: Array<{ id: string; title: string; description: string | null; issueType: string | null; issueNumber: number | null; externalKey: string | null }>;
  startedAsMember: Set<string>;
  contentionGate: Parameters<typeof shouldDeferForContention>[0];
  allowFeatureTypes: boolean;
  passesDependencyGate: (issueId: string) => Promise<boolean>;
}): Promise<string[]> {
  const { lead, candidates } = args;
  const candidateIds = [lead.id, ...candidates.map((c) => c.id)];
  const coupledEdges = await db
    .select({ from: issueDependencies.issueId, to: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.type, "coupled_with"),
      or(inArray(issueDependencies.issueId, candidateIds), inArray(issueDependencies.dependsOnId, candidateIds)),
    ));
  if (coupledEdges.length === 0) return [];
  const component = resolveCoupledComponent(lead.id, coupledEdges);
  if (component.size <= 1) return [];

  const members: string[] = [];
  for (const candidate of candidates) {
    if (members.length >= MAX_TICKET_GROUP_SIZE - 1) break;
    if (candidate.id === lead.id || !component.has(candidate.id)) continue;
    if (args.startedAsMember.has(candidate.id)) continue;
    // A plugin-loop unit carries its loop's skill and its lifecycle is the loop's —
    // it never rides in someone else's workspace.
    if (parsePluginLoopUnitKey(candidate.externalKey)) continue;
    if (!isMonitorEligibleIssue(candidate, args.allowFeatureTypes)) continue;
    if (await hasSkipAutoStartTag(candidate.id)) continue;
    if (shouldDeferForContention(args.contentionGate, candidate.id, candidate.issueNumber)) continue;
    // Any workspace history (own or as a group member, open OR merged) disqualifies:
    // an open one means the ticket is being worked, a merged one means joining a group
    // would re-run reopen semantics the group path does not implement.
    const history = await db.select({ id: workspaces.id }).from(workspaces)
      .where(sql`${workspaces.issueId} = ${candidate.id} OR ${workspaces.id} IN (SELECT workspace_id FROM workspace_issue_members WHERE issue_id = ${candidate.id})`).limit(1);
    if (history.length > 0) continue;
    if (!(await args.passesDependencyGate(candidate.id))) continue;
    members.push(candidate.id);
  }
  if (members.length > 0) {
    const numbers = candidates.filter((c) => members.includes(c.id)).map((c) => `#${c.issueNumber}`).join(", ");
    console.log(`[monitor] Ticket group for #${lead.issueNumber}: coupled members ${numbers} join the same workspace (#661)`);
  }
  return members;
}

/**
 * The per-cycle collaborators BOTH auto-start loops need: the injected deps, the
 * cycle-scoped tallies (skips per project, starts per project), and the resolved
 * tunables. Threading ONE context instead of a dozen parameters is what lets
 * `runAutoStart` be the short orchestrator it now is (#802) — before that split it
 * was a single 59-branch function and the god-module gate's complexity ratchet was
 * red on master.
 */
interface AutoStartCycle {
  prefMap: Map<string, string>;
  baseUrl: string;
  boardEvents: ReturnType<typeof createBoardEvents>;
  logMonitorAction: AutoStartDeps["logMonitorAction"];
  isAutoDrivenProject: (projectId: string) => boolean;
  buildContentionGate: BuildFileContentionGate;
  canDispatch: typeof projectCanDispatch;
  hasFleetOverflowCapacity: typeof defaultHasFleetOverflowCapacity;
  skipInfo: Map<string, AutoStartSkipInfo>;
  noteSkip: (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason, count?: number) => void;
  tunablesFor: (projectId: string) => ReturnType<typeof resolveMonitorTunables>["tunables"];
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
function isHostSaturated(capacity: MachineCapacitySnapshot): boolean {
  return capacity.hold;
}

type ContentionGate = Awaited<ReturnType<BuildFileContentionGate>>;

/** The rows both loops select as start candidates — the shared subset the gates below read. */
interface AutoStartCandidate {
  id: string;
  title: string;
  description: string | null;
  issueType: string | null;
  issueNumber: number | null;
  externalKey: string | null;
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
async function evaluateStartCandidate(args: {
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
}): Promise<{ start: false } | { start: true; isReopenRetry: boolean; priorWorkspaceCount: number }> {
  const { issue, contentionGate, allowFeatureTypes, noteSkip, noteGateSkip } = args;
  // Ticket group (#661): the membership subquery makes a MEMBER issue (with no workspace
  // row of its own — the group workspace is keyed by the lead) look exactly like an issue
  // with its own workspaces, so the open-workspace skip AND the already-merged reconcile
  // below cover group members with no extra query.
  const issueWorkspaces = await db.select({ id: workspaces.id, status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces)
    .where(sql`${workspaces.issueId} = ${issue.id} OR ${workspaces.id} IN (SELECT workspace_id FROM workspace_issue_members WHERE issue_id = ${issue.id})`);
  if (issueWorkspaces.some((w) => w.status !== "closed")) return { start: false };
  const mergedWs = issueWorkspaces.find((w) => w.mergedAt != null);
  let isReopenRetry = false;
  if (mergedWs) {
    // #265: only a DELIBERATE reopen falls through to start again; a merged issue whose
    // status simply had not caught up is still reconciled and skipped as before.
    ({ reopenedAfterMerge: isReopenRetry } = await reconcileStaleMergedIssue(args.reconcileProjectId, issue.id, issue.issueNumber, args.boardEvents, noteSkip, mergedWs.mergedAt));
    if (!isReopenRetry) return { start: false };
    // #361 — but never for a plugin-loop unit. See `loop_unit_reopen_declined`.
    if (parsePluginLoopUnitKey(issue.externalKey)) {
      console.log(`[monitor] Declining reopen-retry for plugin-loop unit issue #${issue.issueNumber} — its workspace already merged and the loop cannot represent a second one (#361)`);
      noteSkip(args.skipProjectId, issue.issueNumber, "loop_unit_reopen_declined");
      return { start: false };
    }
  }
  if (!isMonitorEligibleIssue(issue, allowFeatureTypes)) { noteGateSkip("feature_type_excluded"); return { start: false }; }
  if (await hasSkipAutoStartTag(issue.id)) { noteGateSkip("no_auto_start_tag"); return { start: false }; }
  if (shouldDeferForContention(contentionGate, issue.id, issue.issueNumber)) { noteGateSkip("contention_gate"); return { start: false }; }
  return { start: true, isReopenRetry, priorWorkspaceCount: issueWorkspaces.length };
}

/**
 * Record a strict-fleet hold, WITH the shape of the fleet behind it (#774). Best-effort:
 * a hold must still be recorded (and the cycle must still skip the project) if the fleet
 * snapshot itself fails.
 */
async function recordFleetHold(ctx: AutoStartCycle, projectId: string, dispatchReason: string): Promise<void> {
  let fleetHold: FleetHoldDetail | undefined;
  try {
    const snapshot = await describeFleet({
      database: db,
      projectId,
      providerName: narrowProviderName(ctx.prefMap.get("provider")),
    });
    fleetHold = {
      reason: dispatchReason,
      registered: snapshot.registered,
      online: snapshot.online,
      connected: snapshot.connected,
      eligible: snapshot.eligible,
      freeSlots: snapshot.freeSlots,
      explain: `/api/workers/explain?projectId=${projectId}&issue=<N>`,
    };
  } catch (err) {
    console.warn(`[monitor] could not describe the fleet behind the hold: ${String(err)}`);
  }
  console.log(
    `[monitor] auto-start held for project ${projectId}: ${dispatchReason}` +
      (fleetHold
        ? ` (${fleetHold.connected}/${fleetHold.registered} connected, ${fleetHold.eligible} eligible, ` +
          `${fleetHold.freeSlots} free slots; why for one ticket: ${fleetHold.explain})`
        : ""),
  );
  ctx.noteSkip(projectId, null, "no_available_worker");
  if (fleetHold) {
    const info = ctx.skipInfo.get(projectId);
    if (info) info.fleetHold = fleetHold;
  }
}

/**
 * Record a `machine_saturated` hold, WITH the capacity read behind it (#908) — same
 * reasoning as `recordFleetHold`: the collapsed token in `reasonCounts` cannot carry the
 * measured numbers an operator would need to judge "is this real load or a stale floor",
 * so the shape travels alongside it.
 */
function recordMachineSaturationHold(ctx: AutoStartCycle, projectId: string): void {
  const capacity = ctx.machineCapacity;
  const detail: MachineSaturationDetail =
    capacity.tier === "1"
      ? {
          tier: "1",
          reason: `${capacity.headroomProcesses} headroom process(es), thrashing=${capacity.thrashing}`,
          headroomProcesses: capacity.headroomProcesses,
          thrashing: capacity.thrashing,
        }
      : { tier: "0", reason: capacity.reason, freeGb: capacity.freeGb };
  console.log(
    `[monitor] auto-start held for project ${projectId}: host is saturated (tier ${detail.tier}: ${detail.reason}) ` +
      `and no eligible worker can take the overflow`,
  );
  ctx.noteSkip(projectId, null, "machine_saturated");
  const info = ctx.skipInfo.get(projectId);
  if (info) info.machineSaturation = detail;
}

/**
 * The Todo (and, for auto-driven projects, Backlog) status ids a project pulls candidates
 * from (#536). Returned as one list so the WIP-cap tally and the candidate query cannot
 * disagree about what "queued work" means.
 */
async function resolveCandidateStatusIds(projectId: string, todoStatusId: string, allowFeatureTypes: boolean): Promise<string[]> {
  const ids = [todoStatusId];
  if (allowFeatureTypes) {
    const backlogStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
      .where(sql`${projectStatuses.name} = 'Backlog' AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
    if (backlogStatus.length > 0) ids.push(backlogStatus[0].id);
  }
  return ids;
}

/**
 * #179: WIP is full — but only worth surfacing as a "skipped" cause if there is actually
 * queued Todo/Backlog work waiting behind it, not on every idle project.
 */
async function noteWipCapSkip(ctx: AutoStartCycle, projectId: string, allowFeatureTypes: boolean): Promise<void> {
  const waitingTodoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
  if (waitingTodoStatus.length === 0) return;
  const waitingStatusIds = await resolveCandidateStatusIds(projectId, waitingTodoStatus[0].id, allowFeatureTypes);
  const waitingCount = await db.select({ count: sql<number>`count(*)` }).from(issues)
    .where(and(inArray(issues.statusId, waitingStatusIds), monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()));
  const waiting = Number(waitingCount[0]?.count ?? 0);
  if (waiting > 0) ctx.noteSkip(projectId, null, "wip_cap", waiting);
}

/**
 * The dependency gate for a project's pull loop: a blocker unblocks only when terminal AND
 * landed (#535/#537/#782/#784). Built once per project cycle so the lead candidate and the
 * group-member vetting share one implementation.
 */
function buildDependencyGate(doneStatusIds: Set<string>): (issueId: string) => Promise<boolean> {
  return async (issueId: string): Promise<boolean> => {
    const deps = await db.select({ dependsOnId: issueDependencies.dependsOnId }).from(issueDependencies)
      .where(sql`${issueDependencies.issueId} = ${issueId} AND (${issueDependencies.type} = 'depends_on' OR ${issueDependencies.type} = 'blocked_by')`);
    if (deps.length === 0) return true;
    const blockerIds = [...new Set(deps.map((d) => d.dependsOnId))];
    const blockerIssues = await db
      .select({
        id: issues.id,
        statusId: issues.statusId,
        currentNodeId: issues.currentNodeId,
        currentNodeType: workflowNodes.nodeType,
      })
      .from(issues)
      .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
      .where(inArray(issues.id, blockerIds));
    if (blockerIssues.length !== blockerIds.length) return false;
    const blockerWorkspaces = await db
      .select({ issueId: workspaces.issueId, mergedAt: workspaces.mergedAt, isDirect: workspaces.isDirect })
      .from(workspaces)
      .where(inArray(workspaces.issueId, blockerIds));
    const wsByBlocker = new Map<string, BlockerWorkspaceLanding[]>();
    for (const w of blockerWorkspaces) {
      const list = wsByBlocker.get(w.issueId) ?? [];
      list.push({ mergedAt: w.mergedAt, isDirect: w.isDirect });
      wsByBlocker.set(w.issueId, list);
    }
    return blockerIssues.every((b) => computeBlockerReadiness({
      isTerminal: isTerminalStatusIdView(b, doneStatusIds),
      workspaces: wsByBlocker.get(b.id) ?? [],
    }));
  };
}

/**
 * Interpret the `POST /api/workspaces?async=1&autoStart=1` response for the Todo pull loop.
 * Returns whether the launch was ACCEPTED; the caller owns the counters so their order is
 * unchanged.
 */
async function handleTodoLaunchOutcome(
  ctx: AutoStartCycle,
  resp: Response | null,
  issue: { id: string; title: string; projectId: string; issueNumber: number | null },
  skipProjectId: string,
  memberCount: number,
): Promise<boolean> {
  if (resp?.ok) {
    // Async launch (#269): the 202 body carries a create-job id, not a workspace id;
    // record whichever is available so the action stays traceable.
    const wsData = await resp.json().catch(() => null) as { id?: string; jobId?: string } | null;
    ctx.logMonitorAction("auto_start", wsData?.id ?? wsData?.jobId ?? "unknown", issue.id);
    // #358 — say what the 202 actually means. "Auto-started workspace" was logged here at the
    // moment the create JOB was accepted: at that instant no workspace row exists, the issue is
    // still in its pre-start lane, and no agent has been launched. Provisioning (worktree +
    // AWAITED blocking setup script + context packer) then runs for 84s-8min before the row and
    // the issue transition land in one transaction. That log line is the reason a working board
    // read as "an agent has been running for over a minute while the ticket says Backlog".
    console.log(`[monitor] Auto-start ACCEPTED for unblocked issue "${issue.title}" (${issue.id})${memberCount > 0 ? ` as a ticket group with ${memberCount} member(s)` : ""} — provisioning a workspace (minutes); the issue moves to In Progress when it completes`);
    ctx.boardEvents.broadcast(issue.projectId, "board_changed");
    return true;
  }
  if (resp?.status === 409) {
    // #366: another automatic starter already holds the claim for this issue.
    console.log(`[monitor] Auto-start declined for unblocked issue "${issue.title}" (${issue.id}) — a workspace creation is already in flight for it (#366)`);
    ctx.noteSkip(skipProjectId, issue.issueNumber, "create_in_flight");
    return false;
  }
  if (resp) {
    // #775: a non-ok response (e.g. HTTP 400 "No default branch") was previously
    // invisible — no log, no recorded action. Warn with the status + body and record
    // an auto_start action against the issue so the failure surfaces in recentActions.
    const body = await resp.text().catch(() => "");
    console.warn(`[monitor] Auto-start FAILED for issue "${issue.title}" (${issue.id}): HTTP ${resp.status} ${body.slice(0, 500)}`);
    ctx.logMonitorAction("auto_start", "failed", issue.id);
  }
  return false;
}

/**
 * BACKFILL loop: an issue already In Progress but with no open workspace gets one, up to
 * the project's WIP target. (The Todo pull loop below is the other half — it promotes
 * queued work INTO In Progress.)
 */
async function runInProgressBackfill(ctx: AutoStartCycle, inProgressSt: { id: string; projectId: string }): Promise<void> {
  const allowFeatureTypes = ctx.isAutoDrivenProject(inProgressSt.projectId);
  const wipLimit = ctx.tunablesFor(inProgressSt.projectId).activeAgentsTarget;
  const capacity = await countWipCapacity(db, inProgressSt.id);
  let currentWip = capacity.active;
  if (capacity.inactiveStale > 0) {
    console.log(`[monitor] Auto-start capacity for project ${inProgressSt.projectId}: active=${capacity.active}/${wipLimit} inactiveStale=${capacity.inactiveStale}`);
  }
  if (currentWip >= wipLimit) return;

  // Fleet gate (epic #184): a strict worker-dispatch project must not start
  // work the fleet cannot take — one check per project per cycle.
  const dispatch = await ctx.canDispatch({
    database: db,
    projectId: inProgressSt.projectId,
    providerName: narrowProviderName(ctx.prefMap.get("provider")),
  });
  if (!dispatch.available) {
    // #774 — record the fleet's SHAPE alongside the collapsed reason, so the monitor
    // status carries what the console line used to be the only source of.
    await recordFleetHold(ctx, inProgressSt.projectId, dispatch.reason);
    return;
  }

  // #908: the host is a PLACEMENT input, not a gate — a saturated host still starts work
  // when this project's fleet can absorb it. Only skip when the host is tight AND there is
  // nowhere else to route the overflow.
  if (isHostSaturated(ctx.machineCapacity) && !(await ctx.hasFleetOverflowCapacity({
    database: db,
    projectId: inProgressSt.projectId,
    providerName: narrowProviderName(ctx.prefMap.get("provider")),
  }))) {
    recordMachineSaturationHold(ctx, inProgressSt.projectId);
    return;
  }

  // #119: one snapshot per project per loop, then a cheap synchronous check per candidate.
  const contentionGate = await ctx.buildContentionGate(ctx.prefMap, inProgressSt.projectId);

  const inProgressIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, issueNumber: issues.issueNumber, externalKey: issues.externalKey }).from(issues)
    .where(and(eq(issues.statusId, inProgressSt.id), notDriveOrEpicMetaSql())); // #824: don't backfill a builder onto a meta created directly In Progress
  for (const issue of inProgressIssues) {
    if (currentWip >= wipLimit) break;
    if (ctx.startsRemaining(inProgressSt.projectId) <= 0) break;
    const decision = await evaluateStartCandidate({
      issue,
      reconcileProjectId: inProgressSt.projectId,
      skipProjectId: inProgressSt.projectId,
      allowFeatureTypes,
      contentionGate,
      boardEvents: ctx.boardEvents,
      noteSkip: ctx.noteSkip,
      // This loop never tallied the eligibility/tag/contention gates as skip reasons.
      noteGateSkip: () => {},
    });
    if (!decision.start) continue;
    // #366: ONE branch-name producer for the whole board (`suggestBranchName`). This site had
    // its own inline slug expression, and the Todo-pull loop below had a THIRD one that
    // stripped punctuation instead of turning it into `-` — that is where the observed
    // `8-9-ci-cd` vs `89-cicd` pair came from.
    const baseBranchName = suggestBranchName({ issueNumber: issue.issueNumber, title: issue.title });
    const branch = decision.isReopenRetry ? reopenRetryBranch(baseBranchName, decision.priorWorkspaceCount) : baseBranchName;
    const prompt = issue.description ? `${issue.title}\n\n${issue.description}` : issue.title;
    const launchBody: Record<string, unknown> = { issueId: issue.id, branch, customPrompt: prompt };
    // Auto-driven projects must not stall in plan-only mode (#666).
    if (ctx.isAutoDrivenProject(inProgressSt.projectId)) launchBody.planMode = false;
    // #269: `?async=1` — provisioning is minutes-long (measured 8+ min); a synchronous
    // launch blocked the whole monitor cycle for the duration. 202 + create-job instead.
    // #366: `&autoStart=1` — declare this an automatic starter so the route claims the issue
    // atomically and answers 409 when another starter is already provisioning it.
    const resp = await fetch(`${ctx.baseUrl}/api/workspaces?async=1&autoStart=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
      // #775: surface a thrown launch instead of swallowing it.
      console.warn(`[monitor] Auto-start launch threw for In Progress issue #${issue.issueNumber} (${issue.id}): ${errorMessage(err)}`);
      return null;
    });
    // #366: 409 means another automatic starter holds the claim and is provisioning this very
    // issue right now. That is not a failure and not a consumed slot — the other starter's
    // launch is the one that counts. Recorded as a skip so it stays visible.
    if (resp?.status === 409) {
      console.log(`[monitor] Auto-start declined for In Progress issue #${issue.issueNumber} — a workspace creation is already in flight for it (#366)`);
      ctx.noteSkip(inProgressSt.projectId, issue.issueNumber, "create_in_flight");
      continue;
    }
    // Count the slot as consumed regardless (we attempted a launch this cycle), but
    // only record SUCCESS as an auto_start action; a failed launch records a failure
    // (#775) so it is no longer invisible in the monitor logs / recentActions.
    currentWip++;
    ctx.noteStart(inProgressSt.projectId);
    contentionGate.noteStarted(issue.id);
    if (!resp || !resp.ok) {
      const body = resp ? await resp.text().catch(() => "") : "";
      console.warn(`[monitor] Auto-start FAILED for In Progress issue #${issue.issueNumber} (${issue.id}): ${resp ? `HTTP ${resp.status} ${body.slice(0, 500)}` : "no response"}`);
      ctx.logMonitorAction("auto_start", "failed", issue.id);
      continue;
    }
    ctx.logMonitorAction("auto_start", "", issue.id);
    ctx.boardEvents.broadcast(inProgressSt.projectId, "board_changed");
    // Same correction as below (#358): this is the 202 for an async create job, not a workspace.
    console.log(`[monitor] Auto-start ACCEPTED for In Progress issue #${issue.issueNumber} (no open workspace) — provisioning takes minutes`);
  }
}

/**
 * PULL loop: promote unblocked Todo (and, for auto-driven projects, Backlog) work into a
 * fresh workspace, up to the project's free WIP slots and this cycle's start cap.
 */
async function runTodoPull(ctx: AutoStartCycle, inProgressSt: { id: string; projectId: string }): Promise<void> {
  const allowFeatureTypes = ctx.isAutoDrivenProject(inProgressSt.projectId);
  const wipLimit = ctx.tunablesFor(inProgressSt.projectId).activeAgentsTarget;
  const capacity = await countWipCapacity(db, inProgressSt.id);
  const currentWip = capacity.active;
  if (capacity.inactiveStale > 0) {
    console.log(`[monitor] Auto-start pull capacity for project ${inProgressSt.projectId}: active=${capacity.active}/${wipLimit} inactiveStale=${capacity.inactiveStale}`);
  }

  // #581: hold new starts while a gate holds the build semaphore. Checked per project so
  // a project can opt out, but the resource being protected is the BOX — one project's
  // builder saturates another project's gate just as well.
  if (await shouldQuiesceBuildersForGate(inProgressSt.projectId, db)) {
    ctx.noteSkip(inProgressSt.projectId, null, "verify_gate_running");
    return;
  }

  if (currentWip >= wipLimit) {
    await noteWipCapSkip(ctx, inProgressSt.projectId, allowFeatureTypes);
    return;
  }

  // #908: same placement-not-a-gate check as the backfill loop above — a saturated host
  // still pulls new work when this project's fleet can take it; only skip when neither can.
  if (isHostSaturated(ctx.machineCapacity) && !(await ctx.hasFleetOverflowCapacity({
    database: db,
    projectId: inProgressSt.projectId,
    providerName: narrowProviderName(ctx.prefMap.get("provider")),
  }))) {
    recordMachineSaturationHold(ctx, inProgressSt.projectId);
    return;
  }

  const todoStatus = await db.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = 'Todo' AND ${projectStatuses.projectId} = ${inProgressSt.projectId}`).limit(1);
  if (todoStatus.length === 0) return;

  const slotsAvailable = wipLimit - currentWip;
  // #119: snapshot once, then gate each candidate; launches this cycle feed back
  // via noteStarted so two backlog tickets sharing a registration file don't both
  // start in the SAME cycle.
  const contentionGate = await ctx.buildContentionGate(ctx.prefMap, inProgressSt.projectId);

  // For auto-driven projects, also pull Backlog issues so newly-created tickets
  // start without requiring a manual Backlog→Todo promotion (#536).
  const candidateStatusIds = await resolveCandidateStatusIds(inProgressSt.projectId, todoStatus[0].id, allowFeatureTypes);

  // #774: do NOT pre-truncate the candidate set with an UNORDERED `limit(fetchLimit)`.
  // SQLite returns rows in an arbitrary order, so a small fetchLimit could return only
  // dep-blocked / already-workspaced candidates and silently DROP the one ticket whose
  // blockers are all Done+merged — exactly the ticket `dependency-waves/start-next`
  // launches correctly (it scans ALL issues, orders them, then filters). Fetch all
  // eligible candidates ordered by issue number (deterministic, FIFO-ish) and let the
  // per-issue gates below decide; the slotsAvailable / startsRemaining caps still bound
  // how many actually launch this cycle.
  // #773: skip the feature/enhancement type-exclusion for auto-driven projects.
  const todoIssues = await db.select({ id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType, projectId: issues.projectId, issueNumber: issues.issueNumber, externalKey: issues.externalKey }).from(issues)
    .where(and(inArray(issues.statusId, candidateStatusIds), monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()))
    .orderBy(issues.issueNumber);
  const doneStatuses = await db.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} IN ('Done', 'Cancelled')`);
  const doneStatusIds = new Set(doneStatuses.map((s) => s.id));

  // Candidates consumed as GROUP MEMBERS this cycle: their workspace row is minutes
  // away (async provisioning), so only this in-cycle set stops the loop from also
  // starting them individually.
  const startedAsMember = new Set<string>();

  // Dependency gate, shared by the lead candidate below and the group-member vetting —
  // a blocker unblocks only when terminal AND landed (#535/#537/#782/#784).
  const passesDependencyGate = buildDependencyGate(doneStatusIds);

  let started = 0;
  for (const issue of todoIssues) {
    if (started >= slotsAvailable) break;
    if (ctx.startsRemaining(inProgressSt.projectId) <= 0) {
      ctx.noteSkip(inProgressSt.projectId, issue.issueNumber, "cycle_start_cap");
      break;
    }
    if (startedAsMember.has(issue.id)) continue;
    const decision = await evaluateStartCandidate({
      issue,
      reconcileProjectId: issue.projectId,
      skipProjectId: inProgressSt.projectId,
      allowFeatureTypes,
      contentionGate,
      boardEvents: ctx.boardEvents,
      noteSkip: ctx.noteSkip,
      noteGateSkip: (reason) => ctx.noteSkip(inProgressSt.projectId, issue.issueNumber, reason),
    });
    if (!decision.start) continue;

    if (!(await passesDependencyGate(issue.id))) continue;

    // #366: the THIRD slug producer used to live here — it stripped punctuation instead of
    // turning it into `-`, which is exactly what turned `PM pipeline 8/9: CI/CD & Deployment`
    // into `...-89-cicd-deployment` while `suggestBranchName` produced `...-8-9-ci-cd-deployment`
    // for the same issue. Both names were observed on duplicate workspaces of one issue.
    const baseBranchName = suggestBranchName({ issueNumber: issue.issueNumber, title: issue.title });
    const branch = decision.isReopenRetry ? reopenRetryBranch(baseBranchName, decision.priorWorkspaceCount) : baseBranchName;

    // Ticket group (#661): expand the candidate into a group along its explicit
    // `coupled_with` edges — one workspace, one agent, one review, one gate for the
    // whole set. Only members that are themselves independently startable join; a
    // reopen-retry never groups (its branch/workspace history is its own).
    let memberIssueIds: string[] = [];
    if (!decision.isReopenRetry && isAutoGroupEnabled(ctx.prefMap, issue.projectId)) {
      // Best-effort: grouping must never break the start it decorates.
      memberIssueIds = await resolveAutoStartGroupMembers({
        lead: issue,
        candidates: todoIssues,
        startedAsMember,
        contentionGate,
        allowFeatureTypes,
        passesDependencyGate,
      }).catch((err) => {
        console.warn(`[monitor] ticket-group expansion failed for #${issue.issueNumber} (starting it solo): ${errorMessage(err)}`);
        return [] as string[];
      });
    }

    const launchBody: Record<string, unknown> = { issueId: issue.id, branch };
    if (memberIssueIds.length > 0) launchBody.memberIssueIds = memberIssueIds;
    // Auto-driven projects must not stall in plan-only mode (#666).
    if (ctx.isAutoDrivenProject(issue.projectId)) launchBody.planMode = false;
    // #269: `?async=1` — same as the backfill loop above; the cycle must not block
    // ~8 minutes per launch while the worktree provisions.
    // #366: `&autoStart=1` — claim the issue atomically; 409 = another starter has it.
    const resp = await fetch(`${ctx.baseUrl}/api/workspaces?async=1&autoStart=1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchBody) }).catch((err) => {
      // #775: surface a thrown launch (network/connection error) instead of silently
      // dropping it — record a failure action so it shows in the monitor logs.
      console.warn(`[monitor] Auto-start launch threw for issue "${issue.title}" (${issue.id}): ${errorMessage(err)}`);
      return null;
    });
    const accepted = await handleTodoLaunchOutcome(ctx, resp, issue, inProgressSt.projectId, memberIssueIds.length);
    if (!accepted) continue;
    started++;
    ctx.noteStart(inProgressSt.projectId);
    contentionGate.noteStarted(issue.id);
    // Group members are consumed by THIS start: keep the rest of the cycle (and the
    // contention snapshot) from starting them individually.
    for (const memberId of memberIssueIds) {
      startedAsMember.add(memberId);
      contentionGate.noteStarted(memberId);
    }
  }
}

export async function runAutoStart(prefMap: Map<string, string>, {
  serverPort, boardEvents, logMonitorAction, allowProject, isAutoDrivenProject = () => false,
  buildContentionGate = buildFileContentionGate, canDispatch = projectCanDispatch,
  readMachineCapacity = resolveMachineCapacity, hostOverflowHasFleetCapacity: hasFleetOverflowCapacity = defaultHasFleetOverflowCapacity,
}: AutoStartDeps): Promise<Map<string, AutoStartSkipInfo>> {
  const skipInfo = new Map<string, AutoStartSkipInfo>();
  const noteSkip = (projectId: string, issueNumber: number | null | undefined, reason: AutoStartSkipReason, count = 1) => {
    let info = skipInfo.get(projectId);
    if (!info) { info = { issueNumbers: [], reasonCounts: {} }; skipInfo.set(projectId, info); }
    if (issueNumber != null && !info.issueNumbers.includes(issueNumber)) info.issueNumbers.push(issueNumber);
    info.reasonCounts[reason] = (info.reasonCounts[reason] ?? 0) + count;
  };

  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const inProgressStatuses = (await db.select({ id: projectStatuses.id, projectId: projectStatuses.projectId }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = 'In Progress'`))
    .filter((s) => allowProject(s.projectId));
  if (inProgressStatuses.length === 0) return skipInfo;

  // Per-project effective tunables (Strategy Bullseye when configured, else legacy
  // nudge prefs). `activeAgentsTarget` is the WIP target; `maxNewStartsPerCycle`
  // caps how many NEW workspaces a single cycle launches — counted across BOTH the
  // In-Progress backfill loop and the Todo→sprint pull loop below.
  const tunablesCache = new Map<string, ReturnType<typeof resolveMonitorTunables>["tunables"]>();
  const tunablesFor = (projectId: string) => {
    let t = tunablesCache.get(projectId);
    if (!t) { t = resolveMonitorTunables(prefMap, projectId).tunables; tunablesCache.set(projectId, t); }
    return t;
  };
  const startedByProject = new Map<string, number>();
  const startsRemaining = (projectId: string) => tunablesFor(projectId).maxNewStartsPerCycle - (startedByProject.get(projectId) ?? 0);
  const noteStart = (projectId: string) => startedByProject.set(projectId, (startedByProject.get(projectId) ?? 0) + 1);

  // #908: ONE machine-capacity read for the whole cycle — see `AutoStartCycle.machineCapacity`
  // for why this is cached instead of read per project.
  const machineCapacity = await readMachineCapacity();

  const ctx: AutoStartCycle = {
    prefMap, baseUrl, boardEvents, logMonitorAction, isAutoDrivenProject,
    buildContentionGate, canDispatch, hasFleetOverflowCapacity, skipInfo, noteSkip, tunablesFor, startsRemaining, noteStart,
    machineCapacity,
  };

  // Two passes, in this order and NOT interleaved — unchanged from when both loop bodies
  // were inlined here: every project is backfilled before any project pulls new work.
  for (const inProgressSt of inProgressStatuses) {
    await runInProgressBackfill(ctx, inProgressSt);
  }

  for (const inProgressSt of inProgressStatuses) {
    await runTodoPull(ctx, inProgressSt);
  }

  return skipInfo;
}

/**
 * #594 — re-exported so the many existing importers and the `monitor-auto-start-wip-capacity`
 * suite keep their import path while the implementation lives in `services/`.
 */
export {
  AUTO_START_WIP_STATUSES,
  SKIP_AUTO_START_TAG,
  countActiveWip,
  countWipCapacity,
  type WipCapacitySnapshot,
};
