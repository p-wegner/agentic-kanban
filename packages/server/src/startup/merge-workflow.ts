import { issueTags, issues, preferences, projects, sessions, tags, workspaces } from "@agentic-kanban/shared/schema";
import { runDoneUnmergedScannerNow } from "./done-unmerged-invariant-scanner.js";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
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
import { buildLearningStepPrompt } from "../services/merge-helpers.service.js";

const execFileAsync = promisify(execFile);

export type MergeWorkspace = Pick<typeof workspaces.$inferSelect, "id" | "isDirect" | "branch" | "workingDir" | "baseBranch" | "issueId">;

export interface MergeDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  learningSessionIds: Set<string>;
}

/**
 * Decide whether a set of changed files warrants visual verification.
 *
 * Framework frontend files (.jsx/.tsx/.js/.html/.css/.vue/.svelte/…) always count — they work for
 * any project regardless of directory layout. Plain `.ts` is excluded (it would tag every server
 * change on a TS monorepo). For a WEB project, server-rendered UI authored in `.kt`/`.java` also
 * counts — gated on `isWebProject` so a pure-backend or library JVM project is NOT tagged on every
 * source change. Pure — no git/DB — so it's unit-testable. The tag is a non-blocking nudge, so
 * erring toward more extensions is safe. (#531)
 */
export function hasVisuallyVerifiableChanges(changedFiles: string[], isWebProject: boolean): boolean {
  const FRONTEND_RE = /\.(jsx|tsx|js|mjs|cjs|html|htm|css|scss|less|sass|vue|svelte)$/;
  // `.kt` source only — NOT `.kts` (that's Gradle build scripts, not UI).
  const WEB_SOURCE_RE = /\.(kt|java)$/;
  return changedFiles.some((f) => FRONTEND_RE.test(f) || (isWebProject && WEB_SOURCE_RE.test(f)));
}

/** Tag the issue with "needs-visual-verification" when in after_merge mode and client files changed. */
export async function tagIfNeedsVisualVerification(repoPath: string, branch: string, baseBranch: string | null, issueId: string, now: string, projectId?: string): Promise<void> {
  try {
    const prefRows = await db.select({ key: preferences.key, value: preferences.value }).from(preferences);
    const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
    if (prefMap.get("visual_verification_mode") !== "after_merge") return;

    // Is this a web/service project? Read it from the persisted stack profile (already in prefMap).
    // For a web project authored in a server-rendered-UI language (Ktor/Spring with kotlinx.html,
    // JSP, Compose-for-Web, etc.), the UI lives in .kt/.java — which the framework-extension list
    // below misses, so a Kotlin UI change would never be flagged for visual verification.
    let isWebProject = false;
    if (projectId) {
      try { isWebProject = (JSON.parse(prefMap.get(`project_stack_profile_${projectId}`) ?? "{}") as { isWeb?: boolean } | null)?.isWeb === true; } catch { /* no profile */ }
    }

    const base = baseBranch || "main";
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...${branch}`], { cwd: repoPath });
    const changedFiles = stdout.split("\n").map((f) => f.trim()).filter(Boolean);
    if (!hasVisuallyVerifiableChanges(changedFiles, isWebProject)) return;

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
          const learningPrompt = buildLearningStepPrompt(true);
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
            poll = setInterval(() => {
              void (async () => {
                const sessRows = await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, learningSessId)).limit(1);
                if (sessRows.length > 0 && sessRows[0].status !== "running") {
                  clearInterval(poll);
                  clearTimeout(timeout);
                  console.log(`[workflow] learning step finished: status=${sessRows[0].status}`);
                  resolve();
                }
              })();
            }, 5000);
          });
        } catch (err) {
          console.warn("[workflow] learning step failed (non-fatal):", err);
        }
      }

      if (!workspace.isDirect) {
        const projectRows = await db.select({ repoPath: projects.repoPath, teardownScript: projects.teardownScript, defaultBranch: projects.defaultBranch }).from(projects).where(eq(projects.id, projectId)).limit(1);
        if (projectRows.length === 0) {
          // Guard: project not found — refuse to set Done without a verified merge.
          throw new Error(`Auto-merge aborted: project ${projectId} not found — cannot verify merge for workspace ${workspace.id} (branch ${workspace.branch})`);
        }
        {
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
              await tagIfNeedsVisualVerification(repoPath, workspace.branch, workspace.baseBranch, issueId, now, projectId);
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
              // #763: auto-resolve pure-append hot-file conflicts by concatenation so a
              // wave of tickets that all append to one shared smoke test / log lands
              // without fix-and-merge thrash. Non-append conflicts still throw.
              const mergeOutput = await gitService.mergeBranch(repoPath, workspace.branch, targetBranch, {
                autoResolveAppendConflicts: true,
              });

              // Post-merge invariant: verify the branch tip is now reachable from target.
              // If not, the git merge did not actually land the work (e.g. plumbing anomaly
              // or interrupted ref update) — refuse to set Done so the scanner can catch it.
              const postMergeAncestry = await gitService.checkBranchTipIsAncestor(repoPath, workspace.branch, targetBranch);
              if (!postMergeAncestry.isAncestor) {
                throw new Error(
                  `Post-merge invariant violated: branch '${workspace.branch}' is still not an ancestor of '${targetBranch}' after merge — refusing to move issue to Done (workspace ${workspace.id})`,
                );
              }

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
4. Capture a short WebM proof recording and take a screenshot confirming the UI renders correctly
5. Attach the WebM recording with \`attach_artifact\` using \`type: "video"\`, \`mimeType: "video/webm"\`, \`workspaceId: "${workspace.id}"\`, and a visual-proof caption
6. Report your findings

Write ANY screenshots, log files, or scratch output into a \`.verify/\` directory (it is
gitignored) — never the repo root. Don't leave \`*.log\`, \`*.png\`, or \`*.webm\` artifacts in the checkout.

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
      if (doneStatusId) {
        await db.update(issues).set({ statusId: doneStatusId, updatedAt: now }).where(eq(issues.id, issueId));
        // Advance the workflow node to the `end` node matching Done status, so
        // blocked_by/depends_on dependents can resolve via the node type check (#537).
        await syncCurrentNodeToStatus(db, issueId).catch((err) =>
          console.warn("[workflow] syncCurrentNodeToStatus after merge failed (non-fatal):", err),
        );
      }
      boardEvents.broadcast(projectId, "workspace_merged");
      console.log(`[workflow] auto-merged workspace ${workspace.id}`);
      // Run the done-unmerged invariant scan immediately after merge so silent-merge-loss
      // is caught without waiting for the next periodic tick (#589).
      runDoneUnmergedScannerNow();
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
