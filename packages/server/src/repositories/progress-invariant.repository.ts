import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getRecentSessionBriefs } from "./session.repository.js";
import { getHeldWorkspaceIdsAmong } from "./merge-hold.repository.js";
import { getMergeBackoffState } from "./merge-backoff.repository.js";
import { selectBlockerIds } from "./auto-start.repository.js";
import { getBlockerStatuses } from "./dependency-auto-chain.repository.js";

/** One open ticket's newest workspace, with the DB-side facts the progress invariant decides on. */
export interface OpenTicketRow {
  issueNumber: number | null;
  issueId: string;
  workspaceId: string;
  projectId: string;
  stageName: string;
  workspaceStatus: string;
  readyForMerge: boolean;
  workspaceUpdatedAt: string;
  workingDir: string | null;
  baseBranch: string | null;
  branch: string | null;
  planMode: boolean;
  parentWorkspaceId: string | null;
  hasRunningSession: boolean;
  lastSessionEndedAt: string | null;
  lastSessionTriggerType: string | null;
  backoff: { nextRetryAt: string | null; branchSha: string | null } | null;
  blockedByUnresolved: boolean;
  mergeHeld: boolean;
}

const OPEN_STAGE_NAMES = ["In Progress", "In Review"];
const RESOLVED_BLOCKER_STATUSES = new Set(["Done", "AI Reviewed", "Cancelled"]);

/**
 * The newest unmerged, non-direct workspace of every In Progress / In Review issue in the given
 * projects (a Done issue is not "open"; an older workspace of a reopened issue is not the one that
 * must be driven). Pure reads.
 */
export async function listOpenTicketRows(projectIds: string[], database: Database = db): Promise<OpenTicketRow[]> {
  if (projectIds.length === 0) return [];
  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      issueId: issues.id,
      workspaceId: workspaces.id,
      projectId: issues.projectId,
      stageName: projectStatuses.name,
      workspaceStatus: workspaces.status,
      readyForMerge: workspaces.readyForMerge,
      workspaceUpdatedAt: workspaces.updatedAt,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      branch: workspaces.branch,
      planMode: workspaces.planMode,
      parentWorkspaceId: workspaces.parentWorkspaceId,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      inArray(issues.projectId, projectIds),
      inArray(projectStatuses.name, OPEN_STAGE_NAMES),
      eq(workspaces.isDirect, false),
      isNull(workspaces.mergedAt),
    ))
    .orderBy(desc(workspaces.createdAt));

  const newestPerIssue = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!newestPerIssue.has(r.issueId)) newestPerIssue.set(r.issueId, r);
  const chosen = [...newestPerIssue.values()];
  const held = await getHeldWorkspaceIdsAmong(chosen.map((r) => r.workspaceId), database);

  const out: OpenTicketRow[] = [];
  for (const r of chosen) {
    const recent = await getRecentSessionBriefs(r.workspaceId, 5, database);
    const backoff = await getMergeBackoffState(r.workspaceId, database);
    const blockerIds = await selectBlockerIds(r.issueId, database);
    const blockerStates = blockerIds.length ? await getBlockerStatuses(blockerIds, database) : [];
    out.push({
      ...r,
      hasRunningSession: recent.some((s) => s.status === "running"),
      lastSessionEndedAt: recent[0]?.endedAt ?? null,
      lastSessionTriggerType: recent[0]?.triggerType ?? null,
      backoff: backoff && backoff.nextRetryAt ? { nextRetryAt: backoff.nextRetryAt, branchSha: backoff.branchSha } : null,
      blockedByUnresolved: blockerStates.some((b) => !RESOLVED_BLOCKER_STATUSES.has(b.statusName)),
      mergeHeld: held.has(r.workspaceId),
    });
  }
  return out;
}
