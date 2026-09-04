/**
 * The READS the auto-start gate chain and the Todo-pull loop make, on this side of the
 * persistence boundary (#715).
 *
 * #1021 split `startup/monitor-auto-start.ts` along the seams the general architecture plan
 * names (P3.2): the shared per-issue gate chain into `startup/monitor-auto-start-cycle.ts`
 * and the Todo pull into `startup/monitor-todo-pull.ts`. Those two modules take a
 * `Database` and never value-import `drizzle-orm`, which is only possible because their
 * queries live here — the same drain `repositories/start-scoring.repository.ts` (#942) and
 * `repositories/harness-tag.repository.ts` (#1021) already did for their slices, and what
 * keeps `startup-persistence-boundary-ratchet.test.ts` from gaining two new offenders for a
 * refactor that moved no query at all.
 *
 * Every function here is a literal move of the query it replaces: same columns, same
 * predicates, same order and same number of statements, so the ordered `db.select` mock
 * chains the auto-start suites are built on see exactly the sequence they saw before.
 */
import { issueDependencies, issues, issueTags, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";

/** Does this issue carry the `no-auto-start` tag? */
export async function hasSkipAutoStartTag(issueId: string, tagName: string, database: Database): Promise<boolean> {
  const rows = await database.select({ id: tags.id }).from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(eq(issueTags.issueId, issueId), eq(tags.name, tagName)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The workspace rows that belong to an issue — its OWN plus the ones it rides in as a
 * ticket-group member (#661). The membership subquery is what makes a member look exactly
 * like an issue with its own workspaces to the gate chain's open-workspace skip and its
 * already-merged reconcile, with no extra query.
 */
export function selectIssueWorkspaceStates(issueId: string, database: Database) {
  return database.select({ id: workspaces.id, status: workspaces.status, mergedAt: workspaces.mergedAt }).from(workspaces)
    .where(sql`${workspaces.issueId} = ${issueId} OR ${workspaces.id} IN (SELECT workspace_id FROM workspace_issue_members WHERE issue_id = ${issueId})`);
}

/**
 * Has this issue ANY workspace history — its own or as a group member, open OR merged?
 * Used to disqualify a ticket-group member: an open one means the ticket is being worked, a
 * merged one means joining a group would re-run reopen semantics the group path does not
 * implement.
 */
export async function hasWorkspaceHistory(issueId: string, database: Database): Promise<boolean> {
  const rows = await database.select({ id: workspaces.id }).from(workspaces)
    .where(sql`${workspaces.issueId} = ${issueId} OR ${workspaces.id} IN (SELECT workspace_id FROM workspace_issue_members WHERE issue_id = ${issueId})`).limit(1);
  return rows.length > 0;
}

/** Every `coupled_with` edge touching one of these candidates, from either side (#661). */
export function selectCoupledEdges(candidateIds: string[], database: Database) {
  return database
    .select({ from: issueDependencies.issueId, to: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.type, "coupled_with"),
      or(inArray(issueDependencies.issueId, candidateIds), inArray(issueDependencies.dependsOnId, candidateIds)),
    ));
}

/** The blocker ids an issue names via `depends_on`/`blocked_by`, de-duplicated. */
export async function selectBlockerIds(issueId: string, database: Database): Promise<string[]> {
  const deps = await database.select({ dependsOnId: issueDependencies.dependsOnId }).from(issueDependencies)
    .where(sql`${issueDependencies.issueId} = ${issueId} AND (${issueDependencies.type} = 'depends_on' OR ${issueDependencies.type} = 'blocked_by')`);
  return [...new Set(deps.map((d) => d.dependsOnId))];
}

/** Status + workflow-node state of each blocker — the "is it terminal" half of readiness. */
export function selectBlockerStates(blockerIds: string[], database: Database) {
  return database
    .select({
      id: issues.id,
      statusId: issues.statusId,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, blockerIds));
}

/** The blockers' workspace landings — the "did it actually land" half of readiness. */
export function selectBlockerWorkspaceLandings(blockerIds: string[], database: Database) {
  return database
    .select({ issueId: workspaces.issueId, mergedAt: workspaces.mergedAt, isDirect: workspaces.isDirect })
    .from(workspaces)
    .where(inArray(workspaces.issueId, blockerIds));
}

/**
 * The Todo-pull loop's candidate rows. Wider than `selectScorableCandidates` in
 * `start-scoring.repository.ts` by `projectId` and `externalKey` — the pull loop attributes
 * the reconcile to the issue's OWN project and has to recognise a plugin-loop unit key —
 * and deliberately UNORDERED (#774: an ordered pre-truncation is what silently dropped the
 * one ticket whose blockers had all landed).
 */
export function selectAutoStartCandidates(statusIds: string[], filters: SQL[], database: Database) {
  return database.select({
    id: issues.id, title: issues.title, description: issues.description, issueType: issues.issueType,
    projectId: issues.projectId, issueNumber: issues.issueNumber, externalKey: issues.externalKey,
    priority: issues.priority, createdAt: issues.createdAt, statusChangedAt: issues.statusChangedAt,
  }).from(issues).where(and(inArray(issues.statusId, statusIds), ...filters));
}
