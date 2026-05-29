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
  getJoinStrategy,
  getForkMode,
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
    parent: { id: string; issueId: string; branch: string; workingDir: string | null };
    project: { id: string; repoPath: string };
    issue: { issueNumber: number | null; title: string; description: string | null };
    forkNode: WorkflowNodeRow;
    joinNode: WorkflowNodeRow;
    entry: WorkflowNodeRow;
    childWorkspaceId: string;
    /** Shared mode: run in the parent's worktree on the parent's branch (sequential). */
    sharedWorktree: boolean;
  }): Promise<void> {
    const { parent, project, issue, forkNode, joinNode, entry, childWorkspaceId, sharedWorktree } = params;
    const now = new Date().toISOString();

    // Shared mode reuses the parent worktree + branch; worktree mode forks a new
    // sub-worktree rooted at the parent branch's current HEAD.
    const childBranch = sharedWorktree
      ? parent.branch
      : `${parent.branch}__fork-${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const worktreePath = sharedWorktree
      ? (parent.workingDir ?? project.repoPath)
      : await gitService.createWorktree(project.repoPath, childBranch, parent.branch);

    const skillName = await injectNodeSkill(entry, worktreePath, project.repoPath);
    const transitions = await getOutgoingTransitions(database, entry.id);
    const prompt = sharedWorktree
      ? `You are working on a SHARED worktree for issue #${issue.issueNumber ?? "?"} — "${issue.title}", on branch \`${parent.branch}\`.\n` +
        `This is the "${entry.name}" stage of a fork whose stages run ONE AT A TIME on this same branch/worktree. Earlier stages' work is already committed here. Do ONLY this stage's work, add NEW files or additive changes (avoid rewriting other stages' work), commit it on this branch, then advance to the join stage.\n\n` +
        `${issue.description ?? ""}\n\n` +
        buildTransitionBlock(entry, transitions, childWorkspaceId)
      : `You are working on a PARALLEL BRANCH of issue #${issue.issueNumber ?? "?"} — "${issue.title}".\n` +
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
      .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, workingDir: workspaces.workingDir })
      .from(workspaces)
      .where(eq(workspaces.id, parentWorkspaceId))
      .limit(1);
    if (parentRows.length === 0) return;
    const parent = parentRows[0];
    const sharedWorktree = getForkMode(forkNode.config) === "shared";

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

    // Shared mode runs strictly one stage at a time on the parent branch, so the
    // effective per-workspace concurrency is 1 (the rest queue and drain on join).
    const perWorkspaceCap = sharedWorktree ? 1 : MAX_CONCURRENT_PER_WORKSPACE;
    let launchedNow = 0;
    for (const entry of entries) {
      const childId = randomUUID();
      const projectRunning = await projectRunningForkCount(issue.projectId);
      const canLaunch =
        launchedNow < perWorkspaceCap && projectRunning < MAX_CONCURRENT_PER_PROJECT;
      if (canLaunch) {
        await launchChild({ parent, project, issue, forkNode, joinNode, entry, childWorkspaceId: childId, sharedWorktree });
        launchedNow++;
      } else {
        // Over the concurrency cap: queue the child (no worktree/session yet).
        const now = new Date().toISOString();
        await database.insert(workspaces).values({
          id: childId,
          issueId: parent.issueId,
          branch: sharedWorktree
            ? parent.branch
            : `${parent.branch}__fork-${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
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
      .select({ id: workspaces.id, issueId: workspaces.issueId, branch: workspaces.branch, workingDir: workspaces.workingDir })
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
      const forkNode = q.forkNodeId ? await getNode(database, q.forkNodeId) : null;
      const joinNode = q.forkJoinNodeId ? await getNode(database, q.forkJoinNodeId) : null;
      const entry = q.currentNodeId ? await getNode(database, q.currentNodeId) : null;
      if (!forkNode || !joinNode || !entry) continue;
      const sharedWorktree = getForkMode(forkNode.config) === "shared";
      // Shared mode is strictly sequential (one stage at a time on the parent branch).
      const perWorkspaceCap = sharedWorktree ? 1 : MAX_CONCURRENT_PER_WORKSPACE;
      if (runningCount >= perWorkspaceCap) break;
      if ((await projectRunningForkCount(issue.projectId)) >= MAX_CONCURRENT_PER_PROJECT) break;
      // Remove the placeholder row; launchChild re-inserts a full one with the same id.
      await database.delete(workspaces).where(eq(workspaces.id, q.id));
      await launchChild({ parent, project, issue, forkNode, joinNode, entry, childWorkspaceId: q.id, sharedWorktree });
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
      .select({ id: workspaces.id, branch: workspaces.branch, workingDir: workspaces.workingDir, forkStatus: workspaces.forkStatus, forkNodeId: workspaces.forkNodeId })
      .from(workspaces)
      .where(eq(workspaces.parentWorkspaceId, parent.id));

    // Shared-worktree forks ran sequentially on the parent branch, so their work
    // is already committed here — there's nothing to merge, and their workingDir
    // IS the parent worktree (which must never be removed as a "child" below).
    const forkNodeForMode = children[0]?.forkNodeId ? await getNode(database, children[0].forkNodeId) : null;
    const sharedWorktree = forkNodeForMode ? getForkMode(forkNodeForMode.config) === "shared" : false;

    // Capture each child's diff vs the parent branch BEFORE any merge (a merged
    // child would otherwise diff to nothing).
    const sections: string[] = [];
    for (const c of children) {
      sections.push(await childArtifact(c, parent.branch, project.repoPath));
    }

    // Auto-merge strategy: merge every completed child branch back into the parent
    // branch now, so additive work (e.g. each child writing a different research
    // doc) lands on one branch without the join agent doing it by hand. (Skipped in
    // shared mode — the children already committed onto this branch.)
    const joinStrategy = getJoinStrategy(joinNode.config);
    const mergeResults: { branch: string; status: "merged" | "conflict" | "skipped"; detail?: string }[] = [];
    if (!sharedWorktree && joinStrategy === "merge" && parent.workingDir) {
      // Make sure the parent worktree is on its branch (captures any commits made
      // in detached HEAD) before merging into it.
      await gitService.ensureOnBranch(parent.workingDir, parent.branch).catch(() => {});
      for (const c of children) {
        if (c.forkStatus !== "joined" || !c.branch) {
          mergeResults.push({ branch: c.branch, status: "skipped", detail: c.forkStatus ?? "unknown" });
          continue;
        }
        try {
          // Ensure the child branch ref reflects the agent's commits, then merge.
          // syncWorkingTree: true updates the parent worktree's working tree so the
          // join agent sees the merged state when it runs.
          if (c.workingDir) await gitService.syncBranchToHead(c.workingDir, c.branch).catch(() => {});
          await gitService.mergeBranch(parent.workingDir, c.branch, parent.branch, { syncWorkingTree: true });
          mergeResults.push({ branch: c.branch, status: "merged" });
        } catch (err) {
          // mergeBranch auto-aborts on conflict; the child's work stays on its
          // own branch for the join agent to integrate manually using the diff.
          mergeResults.push({ branch: c.branch, status: "conflict", detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        }
      }
      console.log(`[fork] join "${joinNode.name}" auto-merge: ${mergeResults.map((r) => `${r.branch}=${r.status}`).join(", ")}`);
    }

    const unmerged = mergeResults.filter((r) => r.status === "conflict");
    const mergeSummary = joinStrategy === "merge"
      ? `## Auto-merge results\n\n` +
        mergeResults.map((r) => `- \`${r.branch}\`: **${r.status}**${r.detail ? ` — ${r.detail}` : ""}`).join("\n") +
        `\n\n` +
        (unmerged.length === 0
          ? `All branches were merged into this branch automatically. Review the combined result for coherence; the per-branch diffs below are for reference.\n\n`
          : `${unmerged.length} branch(es) did NOT merge cleanly (the conflicting merge was auto-aborted; that work remains only on its own branch). Integrate them manually using the diffs below.\n\n`)
      : "";

    const headerJob = sharedWorktree
      ? `${children.length} fork stage(s) ran sequentially on this shared branch; all their work is already committed here. Your job at this **${joinNode.name}** stage: verify the combined result is coherent, then advance the workflow.`
      : joinStrategy === "merge"
      ? `${children.length} parallel branch(es) completed and were auto-merged into this branch. Your job at this **${joinNode.name}** stage: verify the combined result is coherent, integrate any branches that failed to merge (listed above), then advance the workflow.`
      : `${children.length} parallel branch(es) completed. Your job at this **${joinNode.name}** stage: review each branch's diff below, consolidate them into a single coherent result on this (parent) branch, resolve any overlaps, and then advance the workflow.`;

    const artifacts =
      `# Parallel fork artifacts\n\n` +
      `Issue #${issue.issueNumber ?? "?"} — "${issue.title}"\n\n` +
      `${headerJob}\n\n` +
      mergeSummary +
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

    // Clean up child sub-worktrees now that diffs are captured. NEVER remove a
    // shared-mode child's workingDir — it IS the parent worktree.
    for (const c of children) {
      if (c.workingDir && c.workingDir !== parent.workingDir) {
        await gitService.removeWorktree(project.repoPath, c.workingDir).catch(() => {});
      }
    }

    boardEvents?.broadcast(issue.projectId, "workflow_join");

    // Launch the parent agent at the join node to consolidate.
    if (getSessionManager) {
      const joinTransitions = await getOutgoingTransitions(database, joinNode.id);
      const consolidateLine = sharedWorktree
        ? `The fork stages ran sequentially on this branch, so all their work is already committed here. Verify the combined result is coherent, then advance the workflow.`
        : joinStrategy === "merge"
        ? `The parallel branches have already been auto-merged into this branch. Verify the combined result is coherent${unmerged.length ? `, integrate the ${unmerged.length} branch(es) that failed to merge (see the artifacts)` : ""}, then advance the workflow.`
        : `Consolidate the branches into a single coherent result on this branch, then advance the workflow.`;
      const prompt =
        `All parallel branches for issue #${issue.issueNumber ?? "?"} — "${issue.title}" have completed.\n` +
        (artifactsPath ? `Read \`WORKFLOW_FORK_ARTIFACTS.md\` in this worktree for each branch's diff and summary.\n` : `${artifacts}\n`) +
        `${consolidateLine}\n\n` +
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
