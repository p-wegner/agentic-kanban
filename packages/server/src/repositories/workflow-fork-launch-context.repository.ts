/**
 * READ-ONLY LAUNCH CONTEXT — everything the fork engine must know BEFORE it can create a
 * child: the preference map (provider/model/caps), the node's attached skill, the parent
 * workspace, the issue being forked, and the project's repo path.
 *
 * Split out of `workflow-fork.repository.ts` (#722, shrink-only cohesion baseline). The
 * boundary is the write/read one that matters here: nothing in this module mutates
 * anything, and every function is a single narrow projection consumed while ASSEMBLING a
 * launch. The rows the launch then writes are owned by
 * `workflow-fork-children.repository.ts`.
 *
 * `projects` is deliberately NOT queried directly — `selectProjectIdAndRepoPath` delegates
 * to `project.repository.ts`, the aggregate owner (#957 / `repository-table-ownership`).
 */
import { eq } from "drizzle-orm";
import { agentSkills, issues, preferences, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function selectAllPreferences(database: Database = db) {
  return database.select().from(preferences);
}

export async function selectAgentSkillById(skillId: string, database: Database = db) {
  return database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
}

export async function selectForkParent(parentWorkspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, workingDir: workspaces.workingDir })
    .from(workspaces)
    .where(eq(workspaces.id, parentWorkspaceId))
    .limit(1);
}

export async function selectForkIssueWithTemplate(issueId: string, database: Database = db) {
  return database
    .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId, workflowTemplateId: issues.workflowTemplateId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function selectForkIssue(issueId: string, database: Database = db) {
  return database
    .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId })
    .from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function selectProjectIdAndRepoPath(projectId: string, database: Database = db) {
  const project = await getProjectById(projectId, database);
  return project ? [{ id: project.id, repoPath: project.repoPath }] : [];
}
