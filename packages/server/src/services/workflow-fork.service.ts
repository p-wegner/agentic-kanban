import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, ne, inArray } from "drizzle-orm";
import {
  issues,
  projects,
  preferences,
  workspaces,
  agentSkills,
  sessions,
  sessionMessages,
} from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import * as realGitService from "./git.service.js";
import {
  getNode,
  getOutgoingTransitions,
  buildTransitionBlock,
  placeWorkspaceOnNode,
  findJoinNode,
  type WorkflowNodeRow,
} from "@agentic-kanban/shared/lib/workflow-engine";
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree } from "@agentic-kanban/shared/lib/agent-skill-files";
import { resolveAgentSettings, toExecutorProvider } from "./agent-settings.service.js";

/** Default concurrency + timeout caps for parallel fork children (#82). */
const MAX_CONCURRENT_PER_WORKSPACE = 2;
const MAX_CONCURRENT_PER_PROJECT = 4;
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

type GitService = typeof realGitService;

export function createWorkflowForkService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;

  async function resolveAgentConfig() {
    const prefRows = await database.select().from(preferences);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    const s = resolveAgentSettings(prefMap);
    const model = s.provider === "claude" ? prefMap.get("default_model") || undefined : undefined;
    return { ...s, model };
  }

  /** Write the node's attached skill into a child worktree, returning its name. */
  async function injectNodeSkill(node: WorkflowNodeRow, worktreePath: string, repoPath: string): Promise<string | null> {
    if (node.skillId) {
      const rows = await database.select().from(agentSkills).where(eq(agentSkills.id, node.skillId)).limit(1);
      if (rows.length > 0) {
        const skill = rows[0];
        const localPrompt = await readLocalSkillPrompt(repoPath, skill.name);
        await writeAgentSkillFile(worktreePath, localPrompt ? { ...skill, prompt: localPrompt } : skill);
        return skill.name;
      }
    }
    if (node.skillName) {
      const copied = await copySkillToWorktree(repoPath, node.skillName, worktreePath);
      return copied ? node.skillName : null;
    }
    return null;
  }

  /** Count fork-child sessions currently running across the whole project. */
  async function projectRunningForkCount(projectId: string): Promise<number> {
    const rows = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(and(eq(issues.projectId, projectId), eq(workspaces.forkStatus, "running")));
    return rows.length;
  }

  /** Actually create the worktree + workspace row + launch the child agent. */
  async function launchChild(params: {
    parent: { id: string; issueId: string; branch: string };
    project: { id: string; repoPath: string };
    issue: { issueNumber: number | null; title: string; description: string | null };
    forkNode: WorkflowNodeRow;
    joinNode: WorkflowNodeRow;
    entry: WorkflowNodeRow;
    childWorkspaceId: string;
  }): Promise<void> {
    const { parent, project, issue, forkNode, joinNode, entry, childWorkspaceId } = params;
    const now = new Date().toISOString();
    const childBranch = `${parent.branch}__fork-${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

    // Sub-worktree rooted at the parent branch's current HEAD.
    const worktreePath = await gitService.createWorktree(project.repoPath, childBranch, parent.branch);

    const skillName = await injectNodeSkill(entry, worktreePath, project.repoPath);
    const transitions = await getOutgoingTransitions(database, entry.id);
    const prompt =
      `You are working on a PARALLEL BRANCH of issue #${issue.issueNumber ?? "?"} — "${issue.title}".\n` +
      `This is the "${entry.name}" branch of a fork; sibling branches run concurrently. Do ONLY this branch's work, commit it, then advance to the join stage so your work can be consolidated.\n\n` +
      `${issue.description ?? ""}\n\n` +
      buildTransitionBlock(entry, transitions, childWorkspaceId);

    const cfg = await resolveAgentConfig();

    await database.insert(workspaces).values({
      id: childWorkspaceId,
      issueId: parent.issueId,
      branch: childBranch,
      workingDir: worktreePath,
      baseBranch: parent.branch,
      status: "active",
      provider: cfg.provider,
      claudeProfile: cfg.claudeProfile ?? null,
      agentCommand: cfg.agentCommand ?? null,
      model: cfg.model ?? null,
      skillId: entry.skillId ?? null,
      currentNodeId: entry.id,
      parentWorkspaceId: parent.id,
      forkNodeId: forkNode.id,
      forkJoinNodeId: joinNode.id,
      forkStatus: "running",
      createdAt: now,
      updatedAt: now,
    });

    // Record the structural fork → entry transition (child path).
    await placeWorkspaceOnNode(database, {
      workspaceId: childWorkspaceId,
      issueId: parent.issueId,
      projectId: project.id,
      fromNodeId: forkNode.id,
      toNode: entry,
      summary: `Fork child started: ${entry.name}`,
      triggeredBy: "system",
      syncIssue: false,
    });

    if (getSessionManager) {
      await getSessionManager()
        .startSession({
          workspaceId: childWorkspaceId,
          prompt,
          agentCommand: cfg.agentCommand,
          agentArgs: cfg.agentArgs,
          claudeProfile: cfg.claudeProfile,
          permissionPromptTool: cfg.permissionPromptTool,
          provider: toExecutorProvider(cfg.provider),
          triggerType: skillName ? `fork:${skillName}` : "fork-child",
          profile: cfg.profile,
          model: cfg.model,
        })
        .catch((err) => {
          console.error(`[fork] child session launch failed (${childWorkspaceId}):`, err instanceof Error ? err.message : String(err));
        });
    }

    // Best-effort timeout: cancel an overdue child so the join can still proceed.
    setTimeout(() => {
      cancelOverdueChild(childWorkspaceId).catch(() => {});
    }, CHILD_TIMEOUT_MS).unref?.();
  }

  /** Spawn fork children for a parent workspace that just entered a parallel-fork node. */
  async function spawnForkChildren(parentWorkspaceId: string, forkNode: WorkflowNodeRow): Promise<void> {
    const parentRows = await database
      .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch })
      .from(workspaces)
      .where(eq(workspaces.id, parentWorkspaceId))
      .limit(1);
    if (parentRows.length === 0) return;
    const parent = parentRows[0];

    const issueRows = await database
      .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId, workflowTemplateId: issues.workflowTemplateId })
      .from(issues)
      .where(eq(issues.id, parent.issueId))
      .limit(1);
    if (issueRows.length === 0) return;
    const issue = issueRows[0];

    const projRows = await database.select({ id: projects.id, repoPath: projects.repoPath }).from(projects).where(eq(projects.id, issue.projectId)).limit(1);
    if (projRows.length === 0) return;
    const project = projRows[0];

    if (!issue.workflowTemplateId) return;
    const joinNode = await findJoinNode(database, issue.workflowTemplateId);
    if (!joinNode) {
      console.warn(`[fork] template ${issue.workflowTemplateId} has a fork but no parallel-join node — skipping fork.`);
      return;
    }

    // Idempotency: if children already exist for this parent+fork, do nothing.
    const existing = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.parentWorkspaceId, parent.id), eq(workspaces.forkNodeId, forkNode.id)));
    if (existing.length > 0) return;

    const edges = await getOutgoingTransitions(database, forkNode.id);
    const entries: WorkflowNodeRow[] = [];
    for (const e of edges) {
      const n = await getNode(database, e.toNodeId);
      if (n) entries.push(n);
    }
    if (entries.length === 0) return;

    boardEvents?.broadcast(issue.projectId, "workflow_fork");

    let launchedNow = 0;
    for (const entry of entries) {
      const childId = randomUUID();
      const projectRunning = await projectRunningForkCount(issue.projectId);
      const canLaunch =
        launchedNow < MAX_CONCURRENT_PER_WORKSPACE && projectRunning < MAX_CONCURRENT_PER_PROJECT;
      if (canLaunch) {
        await launchChild({ parent, project, issue, forkNode, joinNode, entry, childWorkspaceId: childId });
        launchedNow++;
      } else {
        // Over the concurrency cap: queue the child (no worktree/session yet).
        const now = new Date().toISOString();
        await database.insert(workspaces).values({
          id: childId,
          issueId: parent.issueId,
          branch: `${parent.branch}__fork-${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
          status: "active",
          currentNodeId: entry.id,
          parentWorkspaceId: parent.id,
          forkNodeId: forkNode.id,
          forkJoinNodeId: joinNode.id,
          forkStatus: "queued",
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    console.log(`[fork] parent=${parent.id} spawned ${launchedNow}/${entries.length} children now (rest queued).`);
  }

  /** Drain queued children for a parent up to the concurrency caps. */
  async function drainQueued(parentWorkspaceId: string): Promise<void> {
    const parentRows = await database
      .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch })
      .from(workspaces)
      .where(eq(workspaces.id, parentWorkspaceId))
      .limit(1);
    if (parentRows.length === 0) return;
    const parent = parentRows[0];

    const issueRows = await database
      .select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId })
      .from(issues).where(eq(issues.id, parent.issueId)).limit(1);
    if (issueRows.length === 0) return;
    const issue = issueRows[0];
    const projRows = await database.select({ id: projects.id, repoPath: projects.repoPath }).from(projects).where(eq(projects.id, issue.projectId)).limit(1);
    if (projRows.length === 0) return;
    const project = projRows[0];

    const running = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.parentWorkspaceId, parent.id), eq(workspaces.forkStatus, "running")));
    let runningCount = running.length;

    const queued = await database
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.parentWorkspaceId, parent.id), eq(workspaces.forkStatus, "queued")));

    for (const q of queued) {
      if (runningCount >= MAX_CONCURRENT_PER_WORKSPACE) break;
      if ((await projectRunningForkCount(issue.projectId)) >= MAX_CONCURRENT_PER_PROJECT) break;
      const forkNode = q.forkNodeId ? await getNode(database, q.forkNodeId) : null;
      const joinNode = q.forkJoinNodeId ? await getNode(database, q.forkJoinNodeId) : null;
      const entry = q.currentNodeId ? await getNode(database, q.currentNodeId) : null;
      if (!forkNode || !joinNode || !entry) continue;
      // Remove the placeholder row; launchChild re-inserts a full one with the same id.
      await database.delete(workspaces).where(eq(workspaces.id, q.id));
      await launchChild({ parent, project, issue, forkNode, joinNode, entry, childWorkspaceId: q.id });
      runningCount++;
    }
  }

  /** Collect a child's diff (vs the parent branch) for the artifacts file. */
  async function childArtifact(child: { id: string; branch: string; workingDir: string | null; forkStatus: string | null }, parentBranch: string, repoPath: string): Promise<string> {
    let diff = "";
    try {
      diff = child.workingDir
        ? await gitService.getDiff(child.workingDir, parentBranch)
        : await gitService.getDiffFromRepo(repoPath, child.branch, parentBranch);
    } catch {
      diff = "(diff unavailable)";
    }
    const lastMsg = await lastAssistantSummary(child.id);
    const truncated = diff.length > 12000 ? diff.slice(0, 12000) + "\n… (diff truncated)" : diff;
    return [
      `### Branch: ${child.branch}`,
      `Status: ${child.forkStatus ?? "unknown"}`,
      lastMsg ? `\nAgent summary:\n${lastMsg}` : "",
      "\nDiff vs parent:",
      "```diff",
      truncated || "(no changes)",
      "```",
    ].join("\n");
  }

  async function lastAssistantSummary(workspaceId: string): Promise<string | null> {
    const sess = await database.select({ id: sessions.id }).from(sessions).where(eq(sessions.workspaceId, workspaceId)).orderBy(sessions.startedAt);
    if (sess.length === 0) return null;
    const lastSession = sess[sess.length - 1];
    const msgs = await database
      .select({ data: sessionMessages.data })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.sessionId, lastSession.id), eq(sessionMessages.type, "stdout")))
      .orderBy(sessionMessages.createdAt);
    if (msgs.length === 0) return null;
    const tail = msgs.slice(-1)[0]?.data ?? "";
    return tail.length > 1500 ? tail.slice(-1500) : tail;
  }

  /** Mark a child as joined; when all siblings are done, consolidate into the parent. */
  async function handleChildJoined(childWorkspaceId: string): Promise<void> {
    const rows = await database
      .select({ id: workspaces.id, parentWorkspaceId: workspaces.parentWorkspaceId, forkJoinNodeId: workspaces.forkJoinNodeId })
      .from(workspaces)
      .where(eq(workspaces.id, childWorkspaceId))
      .limit(1);
    if (rows.length === 0 || !rows[0].parentWorkspaceId) return;
    const child = rows[0];
    const parentId: string = rows[0].parentWorkspaceId;
    const now = new Date().toISOString();

    await database.update(workspaces).set({ forkStatus: "joined", status: "closed", closedAt: now, updatedAt: now }).where(eq(workspaces.id, childWorkspaceId));

    // Stop the child session if still running — its work is committed on its branch.
    if (getSessionManager) {
      const running = await database.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.workspaceId, childWorkspaceId), eq(sessions.status, "running")));
      for (const s of running) await getSessionManager().stopSession(s.id).catch(() => {});
    }

    await drainQueued(parentId);

    // All children done? (none running or queued)
    const pending = await database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.parentWorkspaceId, parentId), inArray(workspaces.forkStatus, ["running", "queued"])));
    if (pending.length > 0) return;

    await consolidate(parentId);
  }

  /** Write the fork artifacts file and advance the parent into the join node. */
  async function consolidate(parentWorkspaceId: string): Promise<void> {
    const parentRows = await database
      .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, workingDir: workspaces.workingDir, currentNodeId: workspaces.currentNodeId })
      .from(workspaces).where(eq(workspaces.id, parentWorkspaceId)).limit(1);
    if (parentRows.length === 0) return;
    const parent = parentRows[0];

    const issueRows = await database.select({ issueNumber: issues.issueNumber, title: issues.title, description: issues.description, projectId: issues.projectId, workflowTemplateId: issues.workflowTemplateId }).from(issues).where(eq(issues.id, parent.issueId)).limit(1);
    if (issueRows.length === 0 || !issueRows[0].workflowTemplateId) return;
    const issue = issueRows[0];
    const projRows = await database.select({ id: projects.id, repoPath: projects.repoPath }).from(projects).where(eq(projects.id, issue.projectId)).limit(1);
    if (projRows.length === 0) return;
    const project = projRows[0];

    const joinNode = await findJoinNode(database, issue.workflowTemplateId!);
    if (!joinNode) return;

    // Idempotency: only consolidate once (parent not already on/past the join).
    if (parent.currentNodeId === joinNode.id) return;

    const children = await database
      .select({ id: workspaces.id, branch: workspaces.branch, workingDir: workspaces.workingDir, forkStatus: workspaces.forkStatus })
      .from(workspaces)
      .where(eq(workspaces.parentWorkspaceId, parent.id));

    const sections: string[] = [];
    for (const c of children) {
      sections.push(await childArtifact(c, parent.branch, project.repoPath));
    }
    const artifacts =
      `# Parallel fork artifacts\n\n` +
      `Issue #${issue.issueNumber ?? "?"} — "${issue.title}"\n\n` +
      `${children.length} parallel branch(es) completed. Your job at this **${joinNode.name}** stage: review each branch's diff below, consolidate them into a single coherent result on this (parent) branch, resolve any overlaps, and then advance the workflow.\n\n` +
      sections.join("\n\n---\n\n");

    let artifactsPath: string | null = null;
    if (parent.workingDir) {
      artifactsPath = join(parent.workingDir, "WORKFLOW_FORK_ARTIFACTS.md");
      try {
        await writeFile(artifactsPath, artifacts, "utf-8");
      } catch (err) {
        console.warn(`[fork] could not write artifacts file: ${err instanceof Error ? err.message : String(err)}`);
        artifactsPath = null;
      }
    }

    // Advance the PARENT into the join node (structural move) and sync issue status.
    const fromNodeId = parent.currentNodeId;
    await placeWorkspaceOnNode(database, {
      workspaceId: parent.id,
      issueId: parent.issueId,
      projectId: project.id,
      fromNodeId,
      toNode: joinNode,
      summary: `All ${children.length} fork children joined`,
      triggeredBy: "system",
      syncIssue: true,
    });

    // Clean up child sub-worktrees now that diffs are captured.
    for (const c of children) {
      if (c.workingDir) {
        await gitService.removeWorktree(project.repoPath, c.workingDir).catch(() => {});
      }
    }

    boardEvents?.broadcast(issue.projectId, "workflow_join");

    // Launch the parent agent at the join node to consolidate.
    if (getSessionManager) {
      const joinTransitions = await getOutgoingTransitions(database, joinNode.id);
      const prompt =
        `All parallel branches for issue #${issue.issueNumber ?? "?"} — "${issue.title}" have completed.\n` +
        (artifactsPath ? `Read \`WORKFLOW_FORK_ARTIFACTS.md\` in this worktree for each branch's diff and summary.\n` : `${artifacts}\n`) +
        `Consolidate the branches into a single coherent result on this branch, then advance the workflow.\n\n` +
        buildTransitionBlock(joinNode, joinTransitions, parent.id);
      const cfg = await resolveAgentConfig();
      const skillName = await injectNodeSkill(joinNode, parent.workingDir ?? project.repoPath, project.repoPath);
      await getSessionManager()
        .startSession({
          workspaceId: parent.id,
          prompt,
          agentCommand: cfg.agentCommand,
          agentArgs: cfg.agentArgs,
          claudeProfile: cfg.claudeProfile,
          permissionPromptTool: cfg.permissionPromptTool,
          provider: toExecutorProvider(cfg.provider),
          triggerType: skillName ? `join:${skillName}` : "fork-join",
          profile: cfg.profile,
          model: cfg.model,
        })
        .catch((err) => console.error(`[fork] join session launch failed:`, err instanceof Error ? err.message : String(err)));
    }
    console.log(`[fork] consolidated ${children.length} children into parent=${parent.id} at join "${joinNode.name}".`);
  }

  async function cancelOverdueChild(childWorkspaceId: string): Promise<void> {
    const rows = await database.select({ forkStatus: workspaces.forkStatus, parentWorkspaceId: workspaces.parentWorkspaceId }).from(workspaces).where(eq(workspaces.id, childWorkspaceId)).limit(1);
    if (rows.length === 0 || rows[0].forkStatus !== "running") return;
    const now = new Date().toISOString();
    if (getSessionManager) {
      const running = await database.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.workspaceId, childWorkspaceId), eq(sessions.status, "running")));
      for (const s of running) await getSessionManager().stopSession(s.id).catch(() => {});
    }
    await database.update(workspaces).set({ forkStatus: "cancelled", status: "closed", closedAt: now, updatedAt: now }).where(eq(workspaces.id, childWorkspaceId));
    console.warn(`[fork] child ${childWorkspaceId} timed out -> cancelled.`);
    const parentId = rows[0].parentWorkspaceId;
    if (parentId) {
      await drainQueued(parentId);
      const pending = await database.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.parentWorkspaceId, parentId), inArray(workspaces.forkStatus, ["running", "queued"])));
      if (pending.length === 0) await consolidate(parentId);
    }
  }

  /**
   * Orchestration entry point, called after any workflow transition (via the
   * internal endpoint or REST manual transition). Decides whether the workspace
   * just entered a fork (→ spawn children) or a child reached the join (→ mark
   * joined / consolidate).
   */
  async function onWorkspaceEnteredNode(workspaceId: string): Promise<void> {
    try {
      const rows = await database
        .select({ id: workspaces.id, currentNodeId: workspaces.currentNodeId, parentWorkspaceId: workspaces.parentWorkspaceId, forkStatus: workspaces.forkStatus })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (rows.length === 0 || !rows[0].currentNodeId) return;
      const ws = rows[0];
      const node = await getNode(database, rows[0].currentNodeId);
      if (!node) return;

      if (node.nodeType === "parallel-fork" && !ws.parentWorkspaceId) {
        await spawnForkChildren(ws.id, node);
      } else if (node.nodeType === "parallel-join" && ws.parentWorkspaceId && ws.forkStatus === "running") {
        await handleChildJoined(ws.id);
      }
    } catch (err) {
      console.error(`[fork] onWorkspaceEnteredNode(${workspaceId}) failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  return { onWorkspaceEnteredNode, cancelOverdueChild };
}

export type WorkflowForkService = ReturnType<typeof createWorkflowForkService>;
