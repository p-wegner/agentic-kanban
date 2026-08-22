/**
 * SPEC-DRIVEN PHASE NODES — the state a phase launch reads and writes on the workspace
 * it is launching INTO (as opposed to a fork child, which the children module creates).
 *
 * Split out of `workflow-fork.repository.ts` (#722, shrink-only cohesion baseline). A
 * phase node (`spec-driven-phased-planning`) launches an extra session on an EXISTING
 * workspace: the launcher needs the template's builtin key to know the node is a phase
 * node at all, the workspace's repo/issue context to build the prompt, and it stamps the
 * node's skill onto the workspace row. The "is a session already running / has this phase
 * already run?" reads live in `workflow-fork-session-reads.repository.ts` with the rest of
 * the `sessions` access.
 */
import { eq } from "drizzle-orm";
import { issues, projects, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function selectTemplateBuiltinKey(templateId: string, database: Database = db) {
  return database
    .select({ builtinKey: workflowTemplates.builtinKey })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, templateId))
    .limit(1);
}

export async function selectWorkspacePhaseContext(workspaceId: string, database: Database = db) {
  return database
    .select({
      workspaceId: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      projectId: issues.projectId,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      repoPath: projects.repoPath,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function updateWorkspaceSkill(
  workspaceId: string,
  skillId: string | null,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({
    skillId,
    updatedAt: now,
  }).where(eq(workspaces.id, workspaceId));
}
