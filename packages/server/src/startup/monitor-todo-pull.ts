/**
 * The Todo PULL loop of monitor auto-start — extracted from `monitor-auto-start.ts` (#1021,
 * plan item P3.2).
 *
 * One of the two loops a cycle runs, and the larger of them: it promotes unblocked Todo (and,
 * on an auto-driven project, Backlog) work into a fresh workspace, which means it owns the
 * candidate ordering, the dependency gate, the ticket-group expansion (#661) and the launch
 * outcome — none of which the In-Progress backfill has anything to say about. The backfill
 * stays in `monitor-auto-start.ts` beside the orchestrator that sequences the two passes.
 *
 * What both loops share — the cycle context, the host/fleet capacity questions and the
 * per-issue gate chain — lives in `monitor-auto-start-cycle.ts`, which this module imports
 * and never imports back.
 *
 * The persistence boundary (#715): this module takes its `Database` from the cycle and never
 * value-imports `drizzle-orm` — its reads live in `repositories/auto-start.repository.ts` and
 * `repositories/start-scoring.repository.ts`. Behaviour is unchanged: in production
 * `ctx.database` IS the `db` singleton these queries used to reach for directly.
 */
import { computeBlockerReadiness, isTerminalStatusIdView, suggestBranchName, type BlockerWorkspaceLanding } from "@agentic-kanban/shared";
import { resolveCoupledComponent } from "@agentic-kanban/shared/lib/dependency-graph";
import { MAX_TICKET_GROUP_SIZE, isAutoGroupEnabled } from "@agentic-kanban/shared/lib/ticket-group";
import type { Database } from "../db/index.js";
import { parsePluginLoopUnitKey } from "@agentic-kanban/shared/lib/plugin-manifest";
import { resolveGateQuiesce } from "../services/gate-quiesce.js";
import {
  findProjectStatusIdByName,
  findStatusIdsByNames,
  isMonitorEligibleIssue,
  monitorEligibleIssueSql,
  notDriveOrEpicMetaSql,
  resolveCandidateStatusIds,
} from "../repositories/start-scoring.repository.js";
import {
  hasWorkspaceHistory,
  selectAutoStartCandidates,
  selectBlockerIds,
  selectBlockerStates,
  selectBlockerWorkspaceLandings,
  selectCoupledEdges,
} from "../repositories/auto-start.repository.js";
import { shouldDeferForContention } from "./monitor-file-contention.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { countWipCapacity } from "../repositories/wip-capacity.repository.js";
import { holdForHarnessBudget } from "./monitor-harness-budget.js";
import { noteHeldCandidates, noteWipCapSkip } from "./monitor-skip-attribution.js";
import { clampWipToHeadroom, recordMachineSaturationHold as recordMachineSaturationHoldDetail } from "./monitor-start-holds.js";
import {
  evaluateStartCandidate,
  hasFleetOverflow,
  hasSkipAutoStartTag,
  holdContext,
  isHostSaturated,
  reopenRetryBranch,
  type AutoStartCycle,
} from "./monitor-auto-start-cycle.js";

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
  database: Database;
}): Promise<string[]> {
  const { lead, candidates } = args;
  const candidateIds = [lead.id, ...candidates.map((c) => c.id)];
  const coupledEdges = await selectCoupledEdges(candidateIds, args.database);
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
    if (await hasSkipAutoStartTag(candidate.id, args.database)) continue;
    if (shouldDeferForContention(args.contentionGate, candidate.id, candidate.issueNumber)) continue;
    // Any workspace history (own or as a group member, open OR merged) disqualifies:
    // an open one means the ticket is being worked, a merged one means joining a group
    // would re-run reopen semantics the group path does not implement.
    if (await hasWorkspaceHistory(candidate.id, args.database)) continue;
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
 * The dependency gate for a project's pull loop: a blocker unblocks only when terminal AND
 * landed (#535/#537/#782/#784). Built once per project cycle so the lead candidate and the
 * group-member vetting share one implementation.
 */
function buildDependencyGate(doneStatusIds: Set<string>, database: Database): (issueId: string) => Promise<boolean> {
  return async (issueId: string): Promise<boolean> => {
    const blockerIds = await selectBlockerIds(issueId, database);
    if (blockerIds.length === 0) return true;
    const blockerIssues = await selectBlockerStates(blockerIds, database);
    if (blockerIssues.length !== blockerIds.length) return false;
    const blockerWorkspaces = await selectBlockerWorkspaceLandings(blockerIds, database);
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
    ctx.noteIssueStarted(issue.id);
    return true;
  }
  if (resp?.status === 409) {
    // #366: another automatic starter already holds the claim for this issue.
    console.log(`[monitor] Auto-start declined for unblocked issue "${issue.title}" (${issue.id}) — a workspace creation is already in flight for it (#366)`);
    ctx.noteSkip(skipProjectId, issue.issueNumber, "create_in_flight");
    ctx.noteIssueSkip(issue.id, "create_in_flight");
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
 * PULL loop: promote unblocked Todo (and, for auto-driven projects, Backlog) work into a
 * fresh workspace, up to the project's free WIP slots and this cycle's start cap.
 */
export async function runTodoPull(ctx: AutoStartCycle, inProgressSt: { id: string; projectId: string }): Promise<void> {
  const allowFeatureTypes = ctx.isAutoDrivenProject(inProgressSt.projectId);
  const wipLimit = ctx.wipLimitFor(inProgressSt.projectId);
  const capacity = await countWipCapacity(ctx.database, inProgressSt.id);
  const currentWip = capacity.active;
  if (capacity.inactiveStale > 0) {
    console.log(`[monitor] Auto-start pull capacity for project ${inProgressSt.projectId}: active=${capacity.active}/${wipLimit} inactiveStale=${capacity.inactiveStale}`);
  }

  // #581 held new starts while a gate holds the build semaphore; #936 made that hold a
  // PLACEMENT input (see `resolveGateQuiesce`) rather than an unconditional cycle skip.
  const quiesce = await resolveGateQuiesce({
    projectId: inProgressSt.projectId, database: ctx.database,
    hasFleetOverflowCapacity: () => hasFleetOverflow(ctx, inProgressSt.projectId),
  });
  if (quiesce.action === "skip") {
    ctx.noteSkip(inProgressSt.projectId, null, quiesce.reason);
    // #919: attribute the project-wide hold to each ticket it is holding.
    await noteHeldCandidates(ctx, inProgressSt.projectId, allowFeatureTypes, quiesce.reason, ctx.database);
    return;
  }

  if (currentWip >= wipLimit) {
    await noteWipCapSkip(ctx, inProgressSt.projectId, allowFeatureTypes);
    return;
  }

  // #908: same placement-not-a-gate check as the backfill loop above — a saturated host
  // still pulls new work when this project's fleet can take it; only skip when neither can.
  // #1019: same graded clamp as the backfill loop — `slotsAvailable` below is measured
  // against the clamped target, not the configured one.
  const wipClamp = clampWipToHeadroom({ wipLimit, currentWip, capacity: ctx.machineCapacity });
  const hostFull = isHostSaturated(ctx.machineCapacity) && !(await hasFleetOverflow(ctx, inProgressSt.projectId));
  if (hostFull || currentWip >= wipClamp.effective) {
    recordMachineSaturationHoldDetail(holdContext(ctx), inProgressSt.projectId, wipClamp.clamped ? wipClamp : undefined);
    // #919: attribute the project-wide hold to each ticket it is holding.
    await noteHeldCandidates(ctx, inProgressSt.projectId, allowFeatureTypes, "machine_saturated", ctx.database);
    return;
  }

  const todoStatusId = await findProjectStatusIdByName(inProgressSt.projectId, "Todo", ctx.database);
  if (!todoStatusId) return;

  const slotsAvailable = wipClamp.effective - currentWip;
  // #119: snapshot once, then gate each candidate; launches this cycle feed back
  // via noteStarted so two backlog tickets sharing a registration file don't both
  // start in the SAME cycle.
  const contentionGate = await ctx.buildContentionGate(ctx.prefMap, inProgressSt.projectId);

  // For auto-driven projects, also pull Backlog issues so newly-created tickets
  // start without requiring a manual Backlog→Todo promotion (#536).
  const candidateStatusIds = await resolveCandidateStatusIds(inProgressSt.projectId, todoStatusId, allowFeatureTypes, ctx.database);

  // #774: do NOT pre-truncate the candidate set with an UNORDERED `limit(fetchLimit)`.
  // SQLite returns rows in an arbitrary order, so a small fetchLimit could return only
  // dep-blocked / already-workspaced candidates and silently DROP the one ticket whose
  // blockers are all Done+merged — exactly the ticket `dependency-waves/start-next`
  // launches correctly (it scans ALL issues, orders them, then filters). Fetch ALL
  // eligible candidates (unordered) and let the per-issue gates below decide; the
  // slotsAvailable / startsRemaining caps still bound how many actually launch this cycle.
  // #773: skip the feature/enhancement type-exclusion for auto-driven projects.
  // #917: the iteration order used to be `ORDER BY issue_number` (FIFO). It is now a
  // computed SCORE (`orderCandidatesByStartScore` below) — priority x unblock-count x
  // age / predicted-cost x Bullseye segment weight — so a high-priority ticket that
  // unblocks several others starts before an older, lower-priority leaf.
  const todoIssues = await selectAutoStartCandidates(
    candidateStatusIds,
    [monitorEligibleIssueSql(allowFeatureTypes), notDriveOrEpicMetaSql()],
    ctx.database,
  );
  const doneStatusIds = await findStatusIdsByNames(["Done", "Cancelled"], ctx.database);

  await ctx.orderStartCandidates(todoIssues, inProgressSt.projectId, doneStatusIds, ctx.prefMap, ctx.database);

  // #1021: the harness budget, snapshotted once per project per cycle (see the sibling module).
  const harnessGate = await ctx.buildHarnessGate({ database: ctx.database, inProgressStatusId: inProgressSt.id, wipLimit, sharePct: ctx.tunablesFor(inProgressSt.projectId).harnessSharePct, candidateIssueIds: todoIssues.map((i) => i.id) });

  // Candidates consumed as GROUP MEMBERS this cycle: their workspace row is minutes
  // away (async provisioning), so only this in-cycle set stops the loop from also
  // starting them individually.
  const startedAsMember = new Set<string>();

  // Dependency gate, shared by the lead candidate below and the group-member vetting —
  // a blocker unblocks only when terminal AND landed (#535/#537/#782/#784).
  const passesDependencyGate = buildDependencyGate(doneStatusIds, ctx.database);

  let started = 0;
  for (const issue of todoIssues) {
    if (started >= slotsAvailable) break;
    if (ctx.startsRemaining(inProgressSt.projectId) <= 0) {
      ctx.noteSkip(inProgressSt.projectId, issue.issueNumber, "cycle_start_cap");
      // Everything after this candidate in the scored order is held for the same reason —
      // record it on each, or the panel would answer for one ticket and stay silent on the
      // rest of a queue that is blocked identically.
      for (const held of todoIssues.slice(todoIssues.indexOf(issue))) ctx.noteIssueSkip(held.id, "cycle_start_cap");
      break;
    }
    if (startedAsMember.has(issue.id)) continue;
    if (holdForHarnessBudget(harnessGate, issue, inProgressSt.projectId, ctx.noteSkip, ctx.noteIssueSkip)) continue;
    const decision = await evaluateStartCandidate({
      issue,
      reconcileProjectId: issue.projectId,
      skipProjectId: inProgressSt.projectId,
      allowFeatureTypes,
      contentionGate,
      boardEvents: ctx.boardEvents,
      noteSkip: ctx.noteSkip,
      noteGateSkip: (reason) => ctx.noteSkip(inProgressSt.projectId, issue.issueNumber, reason),
      noteIssueSkip: ctx.noteIssueSkip,
      database: ctx.database,
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
        database: ctx.database,
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
    harnessGate.noteStarted(issue.id);
    // Group members are consumed by THIS start: keep the rest of the cycle (and the
    // contention snapshot) from starting them individually.
    for (const memberId of memberIssueIds) {
      startedAsMember.add(memberId);
      contentionGate.noteStarted(memberId);
      // #919: a member has no workspace row of its own (the group workspace is keyed by the
      // lead), so the create-path clear never reaches it — but it IS running, and a stale
      // "held for wip_cap" on it would answer the panel's question wrongly.
      ctx.noteIssueStarted(memberId);
    }
  }
}
