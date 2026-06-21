import { and, eq, inArray } from "drizzle-orm";
import {
  issues,
  projects,
  preferences,
  workspaces,
  workflowTemplates,
  agentSkills,
  sessions,
  sessionMessages,
} from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function selectAllPreferences(database: Database = db) {
  return database.select().from(preferences);
}

export async function selectAgentSkillById(skillId: string, database: Database = db) {
  return database.select().from(agentSkills).where(eq(agentSkills.id, skillId)).limit(1);
}

export async function selectWorkspaceIdById(childWorkspaceId: string, database: Database = db) {
  return database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, childWorkspaceId)).limit(1);
}

export async function updateChildWorkspaceFailed(
  childWorkspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({
    status: "closed",
    forkStatus: "failed",
    closedAt: now,
    updatedAt: now,
  }).where(eq(workspaces.id, childWorkspaceId));
}

export async function insertFailedChildWorkspace(
  insertValues: {
    id: string;
    issueId: string;
    branch: string;
    status: string;
    currentNodeId: string;
    parentWorkspaceId: string;
    forkNodeId: string;
    forkJoinNodeId: string;
    forkStatus: string;
    closedAt: string;
    updatedAt: string;
  },
  now: string,
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values({ ...insertValues, createdAt: now });
}

export async function selectTemplateBuiltinKey(templateId: string, database: Database = db) {
  return database
    .select({ builtinKey: workflowTemplates.builtinKey })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, templateId))
    .limit(1);
}

export async function selectRunningSessionForWorkspace(workspaceId: string, database: Database = db) {
  return database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")))
    .limit(1);
}

export async function selectPhaseSession(
  workspaceId: string,
  triggerType: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.triggerType, triggerType)))
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

export async function selectProjectRunningForkWorkspaces(projectId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, projectId), eq(workspaces.forkStatus, "running")));
}

export async function insertLaunchedChildWorkspace(
  values: {
    id: string;
    issueId: string;
    branch: string;
    workingDir: string;
    baseBranch: string;
    status: string;
    provider: string;
    claudeProfile: string | null;
    agentCommand: string | null;
    model: string | null;
    skillId: string | null;
    currentNodeId: string;
    parentWorkspaceId: string;
    forkNodeId: string;
    forkJoinNodeId: string;
    forkStatus: string;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
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

export async function selectProjectIdAndRepoPath(projectId: string, database: Database = db) {
  const project = await getProjectById(projectId, database);
  return project ? [{ id: project.id, repoPath: project.repoPath }] : [];
}

export async function selectExistingForkChildren(
  parentId: string,
  forkNodeId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), eq(workspaces.forkNodeId, forkNodeId)));
}

export async function insertQueuedChildWorkspace(
  values: {
    id: string;
    issueId: string;
    branch: string;
    status: string;
    currentNodeId: string;
    parentWorkspaceId: string;
    forkNodeId: string;
    forkJoinNodeId: string;
    forkStatus: string;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(workspaces).values(values);
}

export async function selectPendingForkChildren(parentId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), inArray(workspaces.forkStatus, ["running", "queued"])));
}

export async function selectForkIssue(issueId: string, database: Database = db) {
  return database
    .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId })
    .from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function selectRunningForkChildren(parentId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), eq(workspaces.forkStatus, "running")));
}

export async function selectQueuedForkChildren(parentId: string, database: Database = db) {
  return database
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.parentWorkspaceId, parentId), eq(workspaces.forkStatus, "queued")));
}

export async function deleteWorkspaceById(workspaceId: string, database: Database = db): Promise<void> {
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId));
}

export async function selectSessionsForWorkspaceOrdered(workspaceId: string, database: Database = db) {
  return database.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, workspaceId)).orderBy(sessions.startedAt);
}

export async function selectStdoutSessionMessages(sessionId: string, database: Database = db) {
  return database
    .select({ data: sessionMessages.data })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.type, "stdout")))
    .orderBy(sessionMessages.createdAt);
}

export async function selectChildJoinContext(childWorkspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, parentWorkspaceId: workspaces.parentWorkspaceId, forkJoinNodeId: workspaces.forkJoinNodeId })
    .from(workspaces)
    .where(eq(workspaces.id, childWorkspaceId))
    .limit(1);
}

export async function updateChildWorkspaceJoined(
  childWorkspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ forkStatus: "joined", status: "closed", closedAt: now, updatedAt: now }).where(eq(workspaces.id, childWorkspaceId));
}

export async function selectRunningSessionsForWorkspace(workspaceId: string, database: Database = db) {
  return database.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")));
}

export async function selectConsolidateParent(parentWorkspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, workingDir: workspaces.workingDir, currentNodeId: workspaces.currentNodeId })
    .from(workspaces).where(eq(workspaces.id, parentWorkspaceId)).limit(1);
}

export async function selectConsolidateIssue(issueId: string, database: Database = db) {
  return database.select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId, workflowTemplateId: issues.workflowTemplateId }).from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function selectForkChildrenForConsolidate(parentId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, branch: workspaces.branch, workingDir: workspaces.workingDir, forkStatus: workspaces.forkStatus, forkNodeId: workspaces.forkNodeId })
    .from(workspaces)
    .where(eq(workspaces.parentWorkspaceId, parentId));
}

export async function selectCancelOverdueChild(childWorkspaceId: string, database: Database = db) {
  return database.select({ forkStatus: workspaces.forkStatus, parentWorkspaceId: workspaces.parentWorkspaceId }).from(workspaces).where(eq(workspaces.id, childWorkspaceId)).limit(1);
}

export async function updateChildWorkspaceCancelled(
  childWorkspaceId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ forkStatus: "cancelled", status: "closed", closedAt: now, updatedAt: now }).where(eq(workspaces.id, childWorkspaceId));
}

export async function selectWorkspaceNodeContext(workspaceId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id, currentNodeId: workspaces.currentNodeId, parentWorkspaceId: workspaces.parentWorkspaceId, forkStatus: workspaces.forkStatus })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}
