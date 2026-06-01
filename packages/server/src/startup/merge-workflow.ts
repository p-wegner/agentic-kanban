import { issueTags, issues, preferences, projects, sessions, tags, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../db/index.js";
import { MOCK_AGENT_COMMAND, isMockProfile, toExecutorProvider } from "../services/agent-settings.service.js";
import { createBoardEvents } from "../services/board-events.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import * as gitService from "../services/git.service.js";
import { activeMerges, type ActiveMergeLock } from "../services/workspace-internals.js";
import { createBackup } from "../db/backup.js";
import { killProcessesInDir } from "../services/process-cleanup.js";
import { runScript } from "../services/script-runner.js";
import { createSessionManager } from "../services/session.manager.js";
import { getEffectiveProfile, parseProviderPref } from "./review-helpers.js";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";

const execFileAsync = promisify(execFile);

export type MergeWorkspace = Pick<typeof workspaces.$inferSelect, "id" | "isDirect" | "branch" | "workingDir" | "baseBranch" | "issueId">;

export interface MergeDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  learningSessionIds: Set<string>;
}

/** Tag the issue with "needs-visual-verification" when in after_merge mode and client files changed. */
export async function tagIfNeedsVisualVerification(repoPath: string, branch: string, baseBranch: string | null, issueId: string, now: string): Promise<void> {
  try {
    const prefRows = await db.select({ key: preferences.key, value: preferences.value }).from(preferences);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    if (prefMap.get("visual_verification_mode") !== "after_merge") return;

    const base = baseBranch || "main";
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd: repoPath });
    const changedFiles = stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    // Detect frontend file changes regardless of directory structure so the feature works
    // for any project managed by this board, not just the agentic-kanban monorepo.
    const hasClientChanges = changedFiles.some((f) => /\.(jsx|tsx|css|scss|less|sass|vue|svelte)$/.test(f));
    if (!hasClientChanges) return;

    const TAG_NAME = "needs-visual-verification";
    const TAG_COLOR = "#F59E0B";
    const { randomUUID } = await import("node:crypto");
    await db.insert(tags).values({ id: randomUUID(), name: TAG_NAME, color: TAG_COLOR, isBuiltin: true, createdAt: now }).catch(() => {});
    await db.update(tags).set({ isBuiltin: true }).where(eq(tags.name, TAG_NAME)).catch(() => {});
    const [tagRow] = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, TAG_NAME)).limit(1);
    if (!tagRow) return;

    const alreadyTagged = await db.select({ tagId: issueTags.tagId }).from(issueTags).where(eq(issueTags.issueId, issueId)).limit(100);
    if (!alreadyTagged.some((t) => t.tagId === tagRow.id)) {
      await db.insert(issueTags).values({ id: randomUUID(), issueId, tagId: tagRow.id }).catch(() => {});
      console.log(`[workflow] tagged issue ${issueId} with "${TAG_NAME}"`);
    }
  } catch (err) {
    console.warn("[workflow] tagIfNeedsVisualVerification failed (non-fatal):", err);
  }
}

export function createAutoMerge({ sessionManager, boardEvents, learningSessionIds }: MergeDeps) {
  async function recordMergeAttempt(
    workspace: MergeWorkspace,
    eventType: "merged" | "conflict",
    body: string,
    payload: Record<string, unknown> = {},
    createdAt = new Date().toISOString(),
  ) {
    await insertIssueComment({
      issueId: workspace.issueId,
      workspaceId: workspace.id,
      kind: "merge-attempt",
      author: "system",
      body,
      payload: { eventType, workspaceId: workspace.id, branch: workspace.branch, ...payload },
      createdAt,
    }, db).catch((err) => {
      console.warn("[workflow] failed to record merge timeline event:", err instanceof Error ? err.message : String(err));
    });
  }

  return async function autoMerge(workspace: MergeWorkspace, projectId: string, issueId: string, doneStatusId: string | null, now: string) {
    try {
      const prefRowsLearning = await db.select().from(preferences);
      const prefMapLearning = new Map(prefRowsLearning.map((r) => [r.key, r.value]));
      if (prefMapLearning.get("learning_step_before_merge") === "true" && workspace.workingDir) {
        try {
          const learningPrompt = `/learning-step\n\nRun the learning step skill to extract insights from recent session transcripts and update docs/hooks before this workspace is merged.`;
          const learningProfile = prefMapLearning.get("claude_profile") || undefined;
          const agentCmd = isMockProfile(learningProfile) ? MOCK_AGENT_COMMAND : (prefMapLearning.get("agent_command") || undefined);
          const agentArgs = prefMapLearning.get("agent_args") || undefined;
          const claudeProfile = isMockProfile(learningProfile) ? undefined : learningProfile;
          const providerLearnMerge = parseProviderPref(prefMapLearning);
          const effectiveProfileLearnMerge = getEffectiveProfile(prefMapLearning, providerLearnMerge, claudeProfile);
          const profileSelectionLearnMerge = effectiveProfileLearnMerge ? { provider: providerLearnMerge, name: effectiveProfileLearnMerge } : undefined;
          const learningSessId = await sessionManager.startSession({ workspaceId: workspace.id, prompt: learningPrompt, agentCommand: agentCmd, agentArgs, claudeProfile, profile: profileSelectionLearnMerge, provider: toExecutorProvider(providerLearnMerge), triggerType: "learning" });
          learningSessionIds.add(learningSessId);
          console.log(`[workflow] learning step started: session=${learningSessId}`);
          await new Promise<void>((resolve) => {
            let poll: NodeJS.Timeout;
            const timeout = setTimeout(() => { clearInterval(poll); console.log("[workflow] learning step timed out after 3m, proceeding with merge"); resolve(); }, 3 * 60 * 1000);
            poll = setInterval(async () => {
              const sessRows = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learningSessId)).limit(1);
              if (sessRows.length > 0 && sessRows[0].status !== "running") {
                clearInterval(poll);
                clearTimeout(timeout);
                console.log(`[workflow] learning step finished: status=${sessRows[0].status}`);
                resolve();
              }
            }, 5000);
          });
        } catch (err) {
          console.warn("[workflow] learning step failed (non-fatal):", err);
        }
      }

      if (!workspace.isDirect) {
        const projectRows = await db.select({ repoPath: projects.repoPath, teardownScript: projects.teardownScript, defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
        if (projectRows.length > 0) {
          const { repoPath, teardownScript, defaultBranch } = projectRows[0];

          const mergePromise = (async () => {
            const pendingMerge = activeMerges.get(repoPath);
            if (pendingMerge) {
              console.log(`[workflow] auto-merge for workspace ${workspace.id} is queued behind existing merge on ${repoPath}`);
              await pendingMerge.promise.catch(() => {});
            }

            return (async () => {
              if (workspace.workingDir) {
                try { await killProcessesInDir(workspace.workingDir); } catch {}
                if (teardownScript) {
                  try { await runScript(teardownScript, workspace.workingDir, `teardown:${workspace.id}`); } catch {}
                }
              }
              await tagIfNeedsVisualVerification(repoPath, workspace.branch, workspace.baseBranch, issueId, now);
              // Mandatory pre-merge backup. Non-fatal: must not block a legit auto-merge.
              try {
                await createBackup("pre-merge");
              } catch (err) {
                console.warn("[backup] pre-merge backup failed (non-fatal):", err instanceof Error ? err.message : String(err));
              }
              // Guard: refuse merge if main checkout has uncommitted tracked changes.
              const uncommittedInMain = await gitService.getUncommittedTrackedChanges(repoPath);
              if (uncommittedInMain.length > 0) {
                const preview = uncommittedInMain.slice(0, 5).join(", ");
                const suffix = uncommittedInMain.length > 5 ? ` (and ${uncommittedInMain.length - 5} more)` : "";
                console.error(`[workflow] auto-merge blocked: main checkout has ${uncommittedInMain.length} uncommitted tracked change(s): ${preview}${suffix}`);
                boardEvents.broadcast(projectId, "workflow_error");
                emitButlerSystemEvent({ projectId, kind: "merge_failed", workspaceId: workspace.id, text: `Auto-merge blocked for workspace ${workspace.id} (branch ${workspace.branch}): main checkout has ${uncommittedInMain.length} uncommitted tracked change(s).` });
                throw new Error(`Main checkout has ${uncommittedInMain.length} uncommitted tracked change(s) — cannot merge workspace ${workspace.id}. Commit or stash those changes first.`);
              }

              const targetBranch = workspace.baseBranch || defaultBranch || "main";
              const mergeOutput = await gitService.mergeBranch(repoPath, workspace.branch, targetBranch);
              let mergeCommitSha = "";
              try { mergeCommitSha = await gitService.revParse(repoPath, "HEAD"); } catch { /* tolerate */ }
              await recordMergeAttempt(
                workspace,
                "merged",
                `Merged ${workspace.branch} into ${targetBranch}${mergeCommitSha ? ` at ${mergeCommitSha}` : ""}.`,
                { targetBranch, commitSha: mergeCommitSha || null, mergedAt: now, mergeOutput },
                now,
              );
              if (workspace.workingDir) {
                try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch {}
              }
              try { await gitService.deleteBranch(repoPath, workspace.branch); } catch {}

              const verifyAgent = prefMapLearning.get("after_merge_verify_agent") || "none";
              const issueTagged = await db.select({ tagId: issueTags.tagId }).from(issueTags).where(eq(issueTags.issueId, issueId)).limit(100).then((rows) => rows.some((r) => r.tagId !== null));
              if (verifyAgent === "dedicated" && issueTagged) {
                try {
                  const clientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT || "5173";
                  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT || "3001";
                  const verifyPrompt = `You are a visual verification agent. The branch '${workspace.branch}' was just merged into master.

Your task: visually verify that the UI changes look correct in the browser.

1. Use the playwright-cli skill (/playwright-cli) or run playwright directly
2. Navigate to http://localhost:${clientPort}
3. Check the relevant UI sections based on the changed files from branch '${workspace.branch}'
4. Take a screenshot confirming the UI renders correctly and report your findings

If the dev server is not responding, wait 10 seconds and retry once.

Issue ID: ${issueId}
Workspace ID: ${workspace.id}
Server: http://localhost:${serverPort}`;
                  const verifyProfile = prefMapLearning.get("claude_profile") || undefined;
                  const verifyCmd = isMockProfile(verifyProfile) ? MOCK_AGENT_COMMAND : (prefMapLearning.get("agent_command") || undefined);
                  const verifyArgs = prefMapLearning.get("agent_args") || undefined;
                  const verifyProvider = parseProviderPref(prefMapLearning);
                  const effectiveVerifyProfile = getEffectiveProfile(prefMapLearning, verifyProvider, isMockProfile(verifyProfile) ? undefined : verifyProfile);
                  const verifyProfileSelection = effectiveVerifyProfile ? { provider: verifyProvider, name: effectiveVerifyProfile } : undefined;
                  const verifySessId = await sessionManager.startSession({ workspaceId: workspace.id, prompt: verifyPrompt, agentCommand: verifyCmd, agentArgs: verifyArgs, claudeProfile: effectiveVerifyProfile, provider: toExecutorProvider(verifyProvider), triggerType: "verify", profile: verifyProfileSelection, workingDirOverride: repoPath, extraEnv: { KANBAN_SESSION_TYPE: "verify" } });
                  console.log(`[workflow] dedicated verification session started: session=${verifySessId}`);
                } catch (err) {
                  console.warn("[workflow] dedicated verification session failed (non-fatal):", err);
                }
              }
            })();
          })();

          let trackedMergeLock: ActiveMergeLock;
          const trackedMerge = mergePromise.finally(() => {
            if (activeMerges.get(repoPath) === trackedMergeLock) {
              activeMerges.delete(repoPath);
            }
          });
          trackedMergeLock = {
            promise: trackedMerge,
            workspaceId: workspace.id,
            repoPath,
            startedAt: new Date().toISOString(),
            startedAtMs: Date.now(),
          };
          activeMerges.set(repoPath, trackedMergeLock);
          await trackedMerge;
        }
      }

      await db.update(workspaces).set({ status: "closed", workingDir: null, readyForMerge: false, updatedAt: now }).where(eq(workspaces.id, workspace.id));
      if (doneStatusId) await db.update(issues).set({ statusId: doneStatusId, updatedAt: now }).where(eq(issues.id, issueId));
      boardEvents.broadcast(projectId, "workspace_merged");
      console.log(`[workflow] auto-merged workspace ${workspace.id}`);
    } catch (err) {
      console.error("[workflow] auto-merge failed:", err);
      boardEvents.broadcast(projectId, "workflow_error");
      const msg = err instanceof Error ? err.message : String(err);
      await recordMergeAttempt(
        workspace,
        "conflict",
        `Auto-merge failed for ${workspace.branch}: ${msg}`,
        { error: msg },
      );
      emitButlerSystemEvent({ projectId, kind: "merge_failed", workspaceId: workspace.id, text: `Auto-merge failed for workspace ${workspace.id} (branch ${workspace.branch}): ${msg.slice(0, 200)}` });
    }
  };
}
