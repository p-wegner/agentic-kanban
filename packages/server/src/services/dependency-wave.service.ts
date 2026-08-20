import { computeBlockerReadiness, isResolvedDependencyStatusView, isTerminalStatusView, type BlockerWorkspaceLanding, type DependencyWavePlan, type DependencyWaveStartResult } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import type { SessionLauncher } from "./session.manager.js";
import type { GitService } from "./workspace-internals.js";
import { createWorkspaceCrudService } from "./workspace-crud.service.js";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { claimIssueForAutoStart, isAutoStartClaimed } from "./auto-start-claim.js";
import { completeCreateJob, failCreateJob } from "./create-job.service.js";
import {
  getWipLimitPrefMap,
  getInProgressStatusIds,
  getActiveWipCount,
  getProjectIssuesForWave,
  getOpenWorkspaceIssueIds,
  getWaveDependencyRows,
  getUpstreamWorkspaceLandingRows,
} from "../repositories/dependency-wave.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { BLOCKING_DEPENDENCY_TYPES } from "@agentic-kanban/shared/lib/dependency-type-traits";
import { findCycleNodes } from "@agentic-kanban/shared/lib/dependency-graph";
import { resolveMonitorTunables } from "@agentic-kanban/shared/lib/strategy-objective-file";

const STARTABLE_STATUS_NAMES = new Set(["Backlog", "Todo"]);

type BlockingDependencyType = typeof BLOCKING_DEPENDENCY_TYPES[number];

type IssueRow = {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  statusId: string;
  sortOrder: number;
  currentNodeId: string | null;
  currentNodeType: string | null;
};

type DependencyRow = {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
};

export interface DependencyWaveStartDeps {
  getSessionManager?: () => SessionLauncher;
  boardEvents?: BoardEventSink;
  gitService?: GitService;
  createWorkspace?: (
    issue: { id: string; issueNumber: number | null; title: string },
    options: { planMode: boolean },
  ) => Promise<{ id?: string; error?: string }>;
}

function toPlanIssue(issue: IssueRow, extras: {
  startEligible: boolean;
  blockers?: Array<{ issueId: string; issueNumber: number | null; title: string; statusName: string }>;
  reasons?: string[];
}) {
  return {
    id: issue.id,
    issueNumber: issue.issueNumber,
    title: issue.title,
    statusName: issue.statusName,
    startEligible: extras.startEligible,
    blockers: extras.blockers ?? [],
    reasons: extras.reasons ?? [],
  };
}

/** #523: the traversal is shared now; only the edge filter was ever local. */
function findCycleIssueIds(issueIds: string[], deps: DependencyRow[]): Set<string> {
  return findCycleNodes(
    issueIds,
    deps.map((dep) => ({ from: dep.issueId, to: dep.dependsOnId, type: dep.type })),
    (edge) => isBlockingType(edge.type),
  );
}

function isBlockingType(type: string): type is BlockingDependencyType {
  return (BLOCKING_DEPENDENCY_TYPES as readonly string[]).includes(type);
}

/**
 * The WIP limit this project actually runs under (#654).
 *
 * Precedence, most specific first:
 *  1. an explicit caller override (the API's `wipLimit` query param),
 *  2. `wip_limit_<projectId>` — the per-project pref the onboarding wizard writes,
 *  3. `resolveMonitorTunables` — the Strategy Bullseye if there is one, else the legacy global
 *     `nudge_wip_limit`, else its own default.
 *
 * Step 3 is the important one: it is the SAME function the Board Monitor popover reads, so the
 * two surfaces can no longer disagree. Before this, `getWipInfo` read only `nudge_wip_limit`,
 * which is unset in most installs — so it fell through to a hardcoded 5 and offered
 * "Start Next Wave (5)" on a project configured for 2.
 */
async function resolveWaveWipLimit(
  database: Database,
  projectId: string,
  wipLimitOverride?: number,
): Promise<number> {
  if (wipLimitOverride !== undefined && Number.isFinite(wipLimitOverride) && wipLimitOverride > 0) {
    return wipLimitOverride;
  }
  const prefMap = await getWipLimitPrefMap(projectId, database);
  const perProject = Number.parseInt(prefMap.get(`wip_limit_${projectId}`) ?? "", 10);
  if (Number.isFinite(perProject) && perProject > 0) return perProject;
  const { tunables } = resolveMonitorTunables(prefMap, projectId);
  return tunables.activeAgentsTarget > 0 ? tunables.activeAgentsTarget : 5;
}

async function getWipInfo(database: Database, projectId: string, wipLimitOverride?: number) {
  const wipLimit = await resolveWaveWipLimit(database, projectId, wipLimitOverride);

  const inProgressStatusIds = await getInProgressStatusIds(projectId, database);
  if (inProgressStatusIds.length === 0) {
    return { current: 0, limit: wipLimit, available: wipLimit };
  }

  const current = await getActiveWipCount(projectId, inProgressStatusIds, database);
  return { current, limit: wipLimit, available: Math.max(0, wipLimit - current) };
}

export async function buildDependencyWavePlan(
  database: Database,
  projectId: string,
  options: { wipLimit?: number } = {},
): Promise<DependencyWavePlan> {
  const projectIssues = await getProjectIssuesForWave(projectId, database);

  const allIssuesById = new Map(projectIssues.map((issue) => [issue.id, issue]));
  const openIssues = projectIssues.filter((issue) => !isTerminalStatusView(issue));
  const openIssueIds = openIssues.map((issue) => issue.id);

  const openWorkspaceRows = await getOpenWorkspaceIssueIds(openIssueIds, database);
  // #366: a workspace ROW appears only at the END of provisioning (80s to 8+ min), so the
  // rows alone are blind to a start another path already began — and the wave would launch a
  // second workspace for the same issue. An in-flight create counts as having one.
  const issueIdsWithOpenWorkspace = new Set([
    ...openWorkspaceRows.map((row) => row.issueId),
    ...openIssueIds.filter((issueId) => isAutoStartClaimed(issueId)),
  ]);

  const dependencyRows = await getWaveDependencyRows(projectId, projectIssues.length > 0, database);

  const depsByIssue = new Map<string, DependencyRow[]>();
  const upstreamIds = new Set<string>();
  for (const dep of dependencyRows) {
    if (!isBlockingType(dep.type)) continue;
    const existing = depsByIssue.get(dep.issueId) ?? [];
    existing.push(dep);
    depsByIssue.set(dep.issueId, existing);
    upstreamIds.add(dep.dependsOnId);
  }

  // Landing state of every blocker's workspaces (#784): a terminal-status upstream
  // only unblocks dependents once its work is actually ON the base branch
  // (`mergedAt`/`isDirect`). Shared with the monitor auto-start path via
  // `computeBlockerReadiness`.
  const upstreamWorkspaceRows = await getUpstreamWorkspaceLandingRows([...upstreamIds], database);
  const wsByUpstream = new Map<string, BlockerWorkspaceLanding[]>();
  for (const w of upstreamWorkspaceRows) {
    const list = wsByUpstream.get(w.issueId) ?? [];
    list.push({ mergedAt: w.mergedAt, isDirect: w.isDirect });
    wsByUpstream.set(w.issueId, list);
  }

  const cycleIssueIds = findCycleIssueIds(openIssueIds, dependencyRows);
  const readyNow: DependencyWavePlan["readyNow"] = [];
  const blocked: DependencyWavePlan["blocked"] = [];
  const cyclicInvalid: DependencyWavePlan["cyclicInvalid"] = [];

  for (const issue of openIssues) {
    const deps = depsByIssue.get(issue.id) ?? [];
    const startEligible = STARTABLE_STATUS_NAMES.has(issue.statusName) && !issueIdsWithOpenWorkspace.has(issue.id);
    const blockers: Array<{ issueId: string; issueNumber: number | null; title: string; statusName: string }> = [];
    const invalidReasons: string[] = [];

    for (const dep of deps) {
      const upstream = allIssuesById.get(dep.dependsOnId);
      if (!upstream) {
        invalidReasons.push(`Missing upstream issue ${dep.dependsOnId}`);
        continue;
      }
      const upstreamReady = computeBlockerReadiness({
        isTerminal: isResolvedDependencyStatusView(upstream),
        workspaces: wsByUpstream.get(upstream.id) ?? [],
      });
      if (!upstreamReady) {
        blockers.push({
          issueId: upstream.id,
          issueNumber: upstream.issueNumber,
          title: upstream.title,
          statusName: upstream.statusName,
        });
      }
    }

    if (cycleIssueIds.has(issue.id) || invalidReasons.length > 0) {
      cyclicInvalid.push(toPlanIssue(issue, {
        startEligible: false,
        blockers,
        reasons: [
          ...(cycleIssueIds.has(issue.id) ? ["Dependency cycle detected"] : []),
          ...invalidReasons,
        ],
      }));
    } else if (blockers.length > 0) {
      const blockerLabels = blockers.map((blocker) => blocker.issueNumber != null ? `#${blocker.issueNumber}` : blocker.title);
      blocked.push(toPlanIssue(issue, {
        startEligible: false,
        blockers,
        reasons: [`Blocked by open upstream work: ${blockerLabels.join(", ")}`],
      }));
    } else {
      readyNow.push(toPlanIssue(issue, {
        startEligible,
        reasons: startEligible ? [] : [
          issueIdsWithOpenWorkspace.has(issue.id)
            ? "Already has an open workspace"
            : `Status ${issue.statusName} is not auto-startable`,
        ],
      }));
    }
  }

  const wip = await getWipInfo(database, projectId, options.wipLimit);
  return { projectId, readyNow, blocked, cyclicInvalid, wip };
}

export async function startNextDependencyWave(
  database: Database,
  projectId: string,
  deps: DependencyWaveStartDeps = {},
): Promise<DependencyWaveStartResult> {
  const plan = await buildDependencyWavePlan(database, projectId);
  const candidates = plan.readyNow.filter((issue) => issue.startEligible).slice(0, plan.wip.available);
  const started: DependencyWaveStartResult["started"] = [];
  const failed: DependencyWaveStartResult["failed"] = [];

  const workspaceService = deps.createWorkspace
    ? null
    : createWorkspaceCrudService({
      database,
      getSessionManager: deps.getSessionManager,
      boardEvents: deps.boardEvents,
      gitService: deps.gitService,
    });

  for (const issue of candidates) {
    // #366: claim the issue in the create-job registry before provisioning. The plan above was
    // built over several awaits, so re-assert atomically here; a claim that appeared in
    // between means another starter is already provisioning this issue.
    const claim = claimIssueForAutoStart(issue.id);
    if (!claim) {
      failed.push({ issueId: issue.id, issueNumber: issue.issueNumber, error: "a workspace creation for this issue is already in flight (#366)" });
      continue;
    }
    let result: { id?: string; error?: string };
    try {
      // Wave-launched builders go straight to implementing — match the normal
      // New-Workspace default (execute mode), not the high/critical-priority
      // plan-mode default. Without this a codex builder burns minutes planning
      // first, which is indistinguishable from a stalled session (see #767).
      result = deps.createWorkspace
        ? await deps.createWorkspace(issue, { planMode: false })
        // #366: `suggestBranchName` is the ONE branch-naming function. The private
        // `slugifyTitle` this used to call stripped non-alphanumerics instead of turning them
        // into separators, so the same issue got a different branch name depending on which
        // starter won — which is exactly how the duplicate pair was fingerprinted.
        : await workspaceService!.createWorkspace({
          issueId: issue.id,
          branch: suggestBranchName(issue),
          planMode: false,
        });
      completeCreateJob(claim.jobId, result);
    } catch (err) {
      result = { error: errorMessage(err) };
      failCreateJob(claim.jobId, err);
    }

    if (result.error) {
      failed.push({ issueId: issue.id, issueNumber: issue.issueNumber, error: result.error });
    } else {
      started.push({ issueId: issue.id, issueNumber: issue.issueNumber, workspaceId: result.id ?? "unknown" });
    }
  }

  if (started.length > 0) deps.boardEvents?.broadcast(projectId, "board_changed");

  return {
    started,
    failed,
    skipped: {
      wipLimit: plan.wip.limit,
      currentWip: plan.wip.current,
      availableSlots: plan.wip.available,
      readyButNotStarted: Math.max(0, plan.readyNow.filter((issue) => issue.startEligible).length - candidates.length),
    },
  };
}
