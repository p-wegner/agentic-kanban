import type { Database } from "../db/index.js";
import { buildBlockedMap, buildTagMap } from "./board-aggregation.service.js";
import { buildDriveMap } from "./drive-membership.service.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getProjectStatusesOrdered, getCompletedIssuesPage } from "../repositories/project-service.repository.js";
import { buildBoardColumns } from "../lib/board-view.js";
import { ProjectError } from "./project-error.js";
import type { WorkspaceSummary } from "./workspace-summary.service.js";

const ARCHIVE_STATUS_NAMES = new Set(["done", "cancelled"]);

type SummaryResolver = (
  projectId: string,
  issueIds: string[],
  defaultBranch: string | null,
  archivedIssueIds: Set<string>,
) => Promise<Map<string, WorkspaceSummary>>;

/**
 * #1541: a page of Done/Cancelled issues (newest first) for the Completed grid's "load more" and
 * for board search beyond the capped first page. Each row is enriched exactly like a board card.
 */
export async function getCompletedPage(
  deps: { database: Database; resolveSummaryMap: SummaryResolver },
  projectId: string,
  opts: { offset: number; limit: number; query?: string },
) {
  const { database, resolveSummaryMap } = deps;
  const project = await getProjectById(projectId, database);
  if (!project) throw new ProjectError("Project not found", "NOT_FOUND");
  const statuses = await getProjectStatusesOrdered(projectId, database);
  const terminal = statuses.filter((s) => ARCHIVE_STATUS_NAMES.has(s.name.toLowerCase()));
  const { rows, total } = await getCompletedIssuesPage(projectId, terminal.map((s) => s.id), opts, database);
  const issueIds = rows.map((i) => i.id);
  const [workspaceSummaryMap, blockedMap, issueTagMap, driveMap] = await Promise.all([
    resolveSummaryMap(projectId, issueIds, project.defaultBranch, new Set(issueIds)),
    buildBlockedMap(issueIds, database),
    buildTagMap(issueIds, database),
    buildDriveMap(projectId, database),
  ]);
  const columns = buildBoardColumns({
    statuses,
    visibleStatuses: terminal,
    projectIssues: rows,
    workspaceSummaryMap,
    blockedMap,
    issueTagMap,
    driveMap,
    now: Date.now(),
    staleDays: 0,
    inProgressStaleDays: 0,
  });
  const order = new Map(issueIds.map((id, i) => [id, i] as const));
  const page = columns
    .flatMap((c) => c.issues)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return { issues: page, total, offset: opts.offset };
}
