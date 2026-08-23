import { eq, inArray } from "drizzle-orm";
import { showdowns, workspaces, issues, agentSkills, workspaceDiffStatCache } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export async function getIssueForShowdown(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({ id: issues.id, projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

// #502: one definition, in project.repository (this copy already had its shape).
export { getProjectDefaultBranch } from "./project.repository.js";

export async function insertShowdown(
  values: {
    id: string;
    issueId: string;
    status: string;
    winnerWorkspaceId: string | null;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(showdowns).values({
    id: values.id,
    issueId: values.issueId,
    status: values.status,
    winnerWorkspaceId: values.winnerWorkspaceId,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
  });
}

export async function tagWorkspaceWithShowdown(
  workspaceId: string,
  showdownId: string,
  showdownLabel: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({
    showdownId,
    showdownLabel,
  }).where(eq(workspaces.id, workspaceId));
}

export async function getAgentSkillName(
  skillId: string,
  database: Database = db,
): Promise<string | null> {
  return (await firstRow(
    database
      .select({ name: agentSkills.name })
      .from(agentSkills)
      .where(eq(agentSkills.id, skillId))
      .limit(1)
  ))?.name ?? null;
}

export async function getShowdownById(
  showdownId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select()
      .from(showdowns)
      .where(eq(showdowns.id, showdownId))
      .limit(1)
  );
}

export async function getShowdownByIssueId(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select()
      .from(showdowns)
      .where(eq(showdowns.issueId, issueId))
      .orderBy(showdowns.createdAt)
      .limit(1)
  );
}

export async function getShowdownWorkspaces(
  showdownId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      status: workspaces.status,
      showdownLabel: workspaces.showdownLabel,
      skillId: workspaces.skillId,
      model: workspaces.model,
      // #815: the diff-stat memo moved to `workspace_diff_stat_cache`. Aliased back to the
      // same field names, so every consumer of this projected row is untouched by the move.
      diffStatCacheFilesChanged: workspaceDiffStatCache.filesChanged,
      diffStatCacheInsertions: workspaceDiffStatCache.insertions,
      diffStatCacheDeletions: workspaceDiffStatCache.deletions,
    })
    .from(workspaces)
    // #815: LEFT, not inner — a never-diffed workspace has no memo row and must still be
    // returned, or a showdown contestant disappears until its first diff.
    .leftJoin(workspaceDiffStatCache, eq(workspaceDiffStatCache.workspaceId, workspaces.id))
    .where(eq(workspaces.showdownId, showdownId));
}

export async function getAgentSkillNamesByIds(
  skillIds: string[],
  database: Database = db,
) {
  return database
    .select({ id: agentSkills.id, name: agentSkills.name })
    .from(agentSkills)
    .where(inArray(agentSkills.id, skillIds));
}

export async function getShowdownWorkspaceMembership(
  workspaceId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({ id: workspaces.id, showdownId: workspaces.showdownId, issueId: workspaces.issueId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
  );
}

export async function setShowdownWinner(
  showdownId: string,
  winnerWorkspaceId: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(showdowns).set({
    status: "decided",
    winnerWorkspaceId,
    updatedAt,
  }).where(eq(showdowns.id, showdownId));
}

export async function getShowdownWorkspaceIds(
  showdownId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.showdownId, showdownId));
}

// #502: one definition, in issue.repository. This copy returned the ROW object, so its
// caller reached through `.projectId` for a query that only ever selects that column.
export { getIssueProjectId } from "./issue.repository.js";
