import { db as realDb } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { sessions, sessionMessages, workspaces, issues, projects, preferences, agentSkills } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as realAgentService from "../agent.service.js";
import { extractPlan, writePlanFile, buildImplementPrompt } from "../plan-mode.service.js";
import { getHarnessBoolSetting } from "../harness-settings.js";
import { computeScorecard } from "../workspace-scorecard.service.js";
import { computeWorkspaceCodeMetrics } from "../workspace-code-metrics.service.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import type { SessionManagerOptions, SessionState, StartSessionOptions } from "./types.js";
import { workspaceLaunchPreflight } from "../preflight-check.js";

/** Subset of agent.service that the lifecycle depends on. Injectable for tests. */
export type AgentService = typeof realAgentService;

/** Injectable dependencies for the session lifecycle (default to the real singletons). */
export interface SessionLifecycleDeps {
  db?: Database;
  agentService?: AgentService;
  preflight?: typeof workspaceLaunchPreflight;
}

export const ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS = 10_000;

function buildZeroOutputLaunchFailureStats(executor: string, durationMs: number, exitCode: number | null) {
  const reason =
    `Agent launch failed: provider process exited within ${Math.round(ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS / 1000)}s ` +
    "without assistant output, tool activity, or usage stats.";
  return {
    durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: executor,
    success: false,
    launchFailure: true,
    failureReason: reason,
    providerExitCode: exitCode,
    agentSummary: reason,
  };
}

export function createSessionLifecycle(
  state: SessionState,
  options: SessionManagerOptions | undefined,
  broadcast: (sessionId: string, message: AgentOutputMessage) => void,
  deps: SessionLifecycleDeps = {},
) {
  const db = deps.db ?? realDb;
  const agentService = deps.agentService ?? realAgentService;
  const launchPreflight = deps.preflight ?? workspaceLaunchPreflight;
  /** Create a session DB row and launch the agent process. */
  async function startSession(opts: StartSessionOptions): Promise<string> {
    const {
      workspaceId,
      prompt,
      agentCommand,
      agentArgs,
      resumeFromId,
      claudeProfile,
      multiTurn,
      permissionPromptTool,
      planMode,
      resumeWithNewModel,
      provider,
      triggerType,
      profile,
      model,
      contextFiles,
      extraEnv,
      workingDirOverride,
      skipPermissions: skipPermissionsOpt,
    } = opts;

    // Look up workspace to get workingDir
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) throw new Error("Workspace not found");

    const workspace = wsRows[0];
    // Per-call model wins; otherwise inherit the model stored on the workspace so resume/
    // review/follow-up sessions stay on the same model the workspace was created with.
    const effectiveModel = model ?? workspace.model ?? undefined;
    const effectiveWorkingDir = workingDirOverride ?? workspace.workingDir;
    if (!effectiveWorkingDir) throw new Error("Workspace has no working directory; run setup first");

    // Diagnostic: warn when a feature-branch workspace runs in a path that looks like the
    // main checkout (does not contain '.worktrees'). This can happen if the worktree was
    // never created or was cleaned up, and is the most common cause of agent work leaking
    // into the main checkout.
    if (!workspace.isDirect && !effectiveWorkingDir.includes(".worktrees") && !workingDirOverride) {
      console.warn(
        `[session] WARNING: non-direct workspace ${workspaceId} has workingDir outside .worktrees: ${effectiveWorkingDir}. ` +
          `Agent writes will go to this path, which may be the main checkout.`,
      );
    }

    // Look up issue's projectId for activity broadcasting
    const issueRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, workspace.issueId))
      .limit(1);
    const projectId = issueRows.length > 0 ? issueRows[0].projectId : "";

    if (!workspace.isDirect && !workingDirOverride && projectId) {
      const projectRows = await db
        .select({ repoPath: projects.repoPath, defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const project = projectRows[0];
      if (project?.repoPath) {
        const preflight = await launchPreflight({
          repoPath: project.repoPath,
          worktreePath: effectiveWorkingDir,
          baseBranch: workspace.baseBranch || project.defaultBranch,
          branch: workspace.branch,
          isDirect: workspace.isDirect ?? false,
        });
        if (!preflight.ok) {
          throw new Error(preflight.errors.join("\n"));
        }
        if (preflight.refreshed) {
          console.log(`[session] launch preflight refreshed workspace ${workspaceId} from ${workspace.baseBranch || project.defaultBranch}`);
        }
      }
    }

    const executor = provider ?? "claude-code";

    // If resuming, look up the previous session's providerSessionId. Session
    // IDs are provider-local, so never pass a Claude session ID to Copilot or vice versa.
    let providerSessionId: string | undefined;
    if (resumeFromId) {
      const prevRows = await db
        .select({ providerSessionId: sessions.providerSessionId, executor: sessions.executor })
        .from(sessions)
        .where(eq(sessions.id, resumeFromId))
        .limit(1);
      if (prevRows.length > 0 && prevRows[0].providerSessionId && prevRows[0].executor === executor) {
        // Skip mock agent session IDs (e.g. "mock-session-xxx") — they are not resumable
        const sid = prevRows[0].providerSessionId;
        if (!sid.startsWith("mock-session-")) {
          providerSessionId = sid;
          console.log(`[session] resuming: resumeFromId=${resumeFromId} providerSessionId=${providerSessionId}`);
        } else {
          console.log(`[session] skipping resume: providerSessionId=${sid} is a mock session ID`);
        }
      } else if (prevRows.length > 0 && prevRows[0].providerSessionId) {
        console.log(`[session] skipping resume: previous executor=${prevRows[0].executor} current executor=${executor}`);
      }
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    console.log(`[session] starting: workspaceId=${workspaceId} sessionId=${sessionId} workingDir=${effectiveWorkingDir}`);

    // Capture the skill the workspace launched under so Insights "By Skill" can
    // attribute this session even if the workspace's skill changes later. The name
    // is snapshotted because the agent_skills row may be renamed or deleted.
    let sessionSkillId: string | null = workspace.skillId ?? null;
    let sessionSkillName: string | null = null;
    if (sessionSkillId) {
      const skillRows = await db
        .select({ name: agentSkills.name })
        .from(agentSkills)
        .where(eq(agentSkills.id, sessionSkillId))
        .limit(1);
      sessionSkillName = skillRows[0]?.name ?? null;
    }

    // Cache session context for activity broadcasting
    state.sessionContexts.set(sessionId, { workspaceId, issueId: workspace.issueId, projectId });
    if (multiTurn) {
      state.turnStates.set(sessionId, "processing");
    }

    await db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      executor,
      status: "running",
      startedAt: now,
      endedAt: null,
      resumeFromId: resumeFromId ?? null,
      triggerType: triggerType ?? null,
      skillId: sessionSkillId,
      skillName: sessionSkillName,
    });
    state.sessionProviders.set(sessionId, executor);

    // Determine skip_permissions: explicit opt takes priority over global preference.
    const skipPermRows = await db.select().from(preferences).where(eq(preferences.key, "skip_permissions")).limit(1);
    const dbSkipPerms = skipPermRows.length === 0 || skipPermRows[0].value !== "false";
    const skipPermissions = skipPermissionsOpt !== undefined ? skipPermissionsOpt : dbSkipPerms;

    // For Claude only: skip-permissions is conveyed via --dangerously-skip-permissions in agentArgs.
    let effectiveAgentArgs = agentArgs;
    if (executor === "claude-code") {
      if (skipPermissions && !effectiveAgentArgs?.includes("--dangerously-skip-permissions")) {
        effectiveAgentArgs = effectiveAgentArgs
          ? `${effectiveAgentArgs} --dangerously-skip-permissions`
          : "--dangerously-skip-permissions";
      } else if (!skipPermissions && effectiveAgentArgs?.includes("--dangerously-skip-permissions")) {
        effectiveAgentArgs = effectiveAgentArgs
          .split(/\s+/)
          .filter(a => a && a !== "--dangerously-skip-permissions")
          .join(" ") || undefined;
      }
    }

    // Inject HANDOFF.md context if available and not using provider resume or plan mode
    let effectivePrompt = prompt;
    if (effectiveWorkingDir && !planMode && !providerSessionId) {
      try {
        const { readHandoffFile } = await import("../handoff.service.js");
        const handoff = await readHandoffFile(effectiveWorkingDir);
        if (handoff) {
          effectivePrompt = `[SESSION HANDOFF — previous session context for this workspace. Use it to avoid re-reading files you already explored.]\n\n${handoff}\n---\n\n${prompt}`;
          console.log(`[session] HANDOFF.md injected: workspaceId=${workspaceId} size=${handoff.length}`);
        }
      } catch { /* handoff not available — proceed without it */ }
    }

    try {
      const proc = agentService.launch(effectiveWorkingDir, sessionId, effectivePrompt, effectiveAgentArgs, (event) => {
        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        if (event.type === "exit") {
          // Always clean up in-memory state regardless of DB result
          state.sessionContexts.delete(sessionId);
          state.turnStates.delete(sessionId);
          state.sessionProviders.delete(sessionId);
          const hadExitPlanModeDenied = state.sessionExitPlanModeDenied.delete(sessionId);

          // Skip DB update if user explicitly stopped — stopSession already wrote "stopped"
          if (state.stoppedByUser.has(sessionId)) {
            state.stoppedByUser.delete(sessionId);
            state.sessionFinalText.delete(sessionId);
            state.sessionSubstantiveOutput.delete(sessionId);
            options?.onSessionExit?.(workspaceId, sessionId, event.exitCode ?? null, planMode);
            return;
          }

          const planText = state.sessionFinalText.get(sessionId);
          const hadSubstantiveOutput =
            state.sessionSubstantiveOutput.has(sessionId) || Boolean(planText && planText.trim().length > 0);
          state.sessionSubstantiveOutput.delete(sessionId);
          state.sessionFinalText.delete(sessionId);

          const endNow = new Date().toISOString();
          const exitCode = event.exitCode ?? null;
          const durationMs = Math.max(0, new Date(endNow).getTime() - new Date(now).getTime());
          if (!hadSubstantiveOutput && durationMs <= ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS) {
            const stats = buildZeroOutputLaunchFailureStats(executor, durationMs, exitCode);
            const effectiveExitCode = 1;
            void (async () => {
              await db.update(sessions)
                .set({ status: "stopped", endedAt: endNow, exitCode: String(effectiveExitCode), stats: JSON.stringify(stats) })
                .where(eq(sessions.id, sessionId));
              await db.insert(sessionMessages).values({
                sessionId,
                type: "stderr",
                data: stats.failureReason,
                exitCode: null,
              });
              await db.update(workspaces)
                .set({ status: "idle", updatedAt: endNow })
                .where(eq(workspaces.id, workspaceId));
            })()
              .catch((err) => console.error("Failed to record zero-output launch failure:", err))
              .finally(() => options?.onSessionExit?.(workspaceId, sessionId, effectiveExitCode, planMode));
            return;
          }

          const sessionFinalized = (async () => {
            await db.update(sessions)
              .set({ status: "completed", endedAt: endNow, exitCode: String(exitCode ?? 0) })
              .where(eq(sessions.id, sessionId));

            // Write HANDOFF.md before workflow callbacks can launch the next session.
            if (effectiveWorkingDir) {
              try {
                const { writeHandoffFile } = await import("../handoff.service.js");
                await writeHandoffFile(effectiveWorkingDir, sessionId, db, workspace.baseBranch);
                console.log(`[session] HANDOFF.md written: workspaceId=${workspaceId} sessionId=${sessionId}`);
              } catch (err) {
                console.warn(`[session] HANDOFF.md write failed: sessionId=${sessionId}`, err);
              }
            }
          })()
            .catch((err) => console.error("Failed to finalize session:", err));
          sessionFinalized.finally(() => {
            // Always fire the workflow callback even if finalization failed.
            options?.onSessionExit?.(workspaceId, sessionId, exitCode, planMode);
            computeScorecard(workspaceId, db).catch(() => {});
            computeWorkspaceCodeMetrics(workspaceId, db).catch(() => {});
          });
          // Auto-resume: if ExitPlanMode was denied and workspace wasn't in plan-only mode,
          // start a new session with --resume and a "proceed" prompt
          if (hadExitPlanModeDenied && !planMode) {
            const resumeCount = state.workspaceAutoResumeCount.get(workspaceId) ?? 0;
            if (resumeCount < 1) {
              state.workspaceAutoResumeCount.set(workspaceId, resumeCount + 1);
              console.log(`[session] auto-resuming after ExitPlanMode denial: workspaceId=${workspaceId} resumeFromId=${sessionId}`);
              sessionFinalized.finally(() => startSession({
                workspaceId,
                prompt: "Your plan has been approved. Proceed with the implementation now.",
                agentCommand,
                agentArgs: effectiveAgentArgs,
                resumeFromId: sessionId,
                claudeProfile,
                multiTurn: undefined,
                permissionPromptTool,
                planMode: false,
                resumeWithNewModel: undefined,
                provider,
                triggerType: "agent",
                profile,
              })).catch((err) => console.error(`[session] auto-resume failed: workspaceId=${workspaceId}`, err));
            } else {
              console.log(`[session] skipping auto-resume: workspaceId=${workspaceId} already auto-resumed ${resumeCount} time(s)`);
            }
          }

          // All-provider plan mode: a read-only plan run just finished. Persist the plan to PLAN.md,
          // leave plan mode, then either auto-continue or park awaiting human approval.
          if (planMode && exitCode === 0 && workspace.workingDir && planText) {
            sessionFinalized.then(async () => {
              try {
                const plan = extractPlan(planText);
                if (!plan) {
                  console.warn(`[session] plan-mode run produced no plan text: workspaceId=${workspaceId}`);
                  return;
                }
                const planPath = writePlanFile(workspace.workingDir!, plan);
                await db.update(workspaces).set({ planMode: false, updatedAt: new Date().toISOString() }).where(eq(workspaces.id, workspaceId));

                const harness = provider === "codex" ? "codex" : provider === "copilot" ? "copilot" : "claude";
                const prefRows = await db.select().from(preferences);
                const prefMap = new Map(prefRows.map((r) => [r.key, r.value]));
                const autoContinue = getHarnessBoolSetting(prefMap, harness, "plan_auto_continue");

                if (autoContinue) {
                  console.log(`[session] plan ready (${planPath}) — auto-continuing to implementation: workspaceId=${workspaceId}`);
                  await db.update(workspaces).set({ status: "active", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, workspaceId));
                  await startSession({
                    workspaceId,
                    prompt: buildImplementPrompt(),
                    agentCommand,
                    agentArgs: effectiveAgentArgs,
                    claudeProfile,
                    permissionPromptTool,
                    planMode: false,
                    provider,
                    triggerType: "plan-implement",
                    profile,
                  });
                } else {
                  console.log(`[session] plan ready (${planPath}) — awaiting human approval: workspaceId=${workspaceId}`);
                  await db.update(workspaces).set({ pendingPlanPath: planPath, status: "awaiting-plan-approval", updatedAt: new Date().toISOString() }).where(eq(workspaces.id, workspaceId));
                }
              } catch (err) {
                console.error(`[session] plan completion handling failed: workspaceId=${workspaceId}`, err);
              }
            });
          }

        }
      // When resumeWithNewModel is true, omit --resume so the new profile/provider is used instead
      }, resumeWithNewModel ? undefined : providerSessionId, agentCommand, claudeProfile, multiTurn, permissionPromptTool, planMode, provider, profile, extraEnv, skipPermissions, effectiveModel, contextFiles);

      // Persist PID so hot-reload can detect surviving processes
      if (proc.pid) {
        db.update(sessions)
          .set({ pid: proc.pid })
          .where(eq(sessions.id, sessionId))
          .catch((err) => console.error("Failed to store session pid:", err));
      }
    } catch (err) {
      // Clean up zombie session state if launch failed
      state.sessionContexts.delete(sessionId);
      state.turnStates.delete(sessionId);
      state.sessionProviders.delete(sessionId);
      state.sessionSubstantiveOutput.delete(sessionId);
      await db.update(sessions)
        .set({ status: "stopped", endedAt: new Date().toISOString() })
        .where(eq(sessions.id, sessionId))
        .catch(() => {});
      throw err;
    }

    return sessionId;
  }

  /** Stop a running session by closing stdin (graceful) then killing the agent process. */
  async function stopSession(sessionId: string): Promise<boolean> {
    console.log(`[session] stopping: sessionId=${sessionId}`);
    // Mark as user-stopped so the exit handler doesn't overwrite the DB status
    state.stoppedByUser.add(sessionId);
    // Clean up in-memory state immediately
    state.turnStates.delete(sessionId);
    state.sessionSubstantiveOutput.delete(sessionId);
    // Try graceful shutdown first (close stdin so agent finishes)
    const closed = agentService.closeStdin(sessionId);
    if (closed) {
      // Give the agent a moment to exit gracefully
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // If still running, force kill
      if (agentService.getProcess(sessionId)) {
        agentService.kill(sessionId);
      }
    } else {
      agentService.kill(sessionId);
    }
    const now = new Date().toISOString();
    await db
      .update(sessions)
      .set({ status: "stopped", endedAt: now })
      .where(eq(sessions.id, sessionId));
    return true;
  }

  /** Send a follow-up message to a running session (multi-turn). */
  function sendTurn(sessionId: string, content: string): { ok: boolean; error?: string; stale?: boolean } {
    const turnState = state.turnStates.get(sessionId);
    if (!turnState) {
      // Session exited (turnStates cleared on exit) — treat as stale so caller can --resume
      if (!isProcessAlive(sessionId)) {
        return { ok: false, error: "Agent process has exited", stale: true };
      }
      return { ok: false, error: "Session not found or not in multi-turn mode" };
    }
    if (turnState !== "waiting") {
      // Check if the process is actually still alive before reporting "still processing"
      if (!isProcessAlive(sessionId)) {
        cleanupStaleSession(sessionId).catch(err => console.error("Failed to cleanup stale session:", err));
        return { ok: false, error: "Agent process is no longer running", stale: true };
      }
      return { ok: false, error: "Agent is still processing the previous turn" };
    }
    // Even in "waiting" state, verify the process is alive
    if (!isProcessAlive(sessionId)) {
      cleanupStaleSession(sessionId).catch(err => console.error("Failed to cleanup stale session:", err));
      return { ok: false, error: "Agent process is no longer running", stale: true };
    }
    const sent = agentService.sendInput(sessionId, content);
    if (!sent) {
      return { ok: false, error: "Failed to send input to agent (stdin closed or process gone)" };
    }
    state.turnStates.set(sessionId, "processing");
    return { ok: true };
  }

  /** Get the current turn state for a session. */
  function getTurnState(sessionId: string): "processing" | "waiting" | undefined {
    return state.turnStates.get(sessionId);
  }

  /** Check if an agent process is actually alive. Returns false if process is gone. */
  function isProcessAlive(sessionId: string): boolean {
    return agentService.isPidAlive(sessionId);
  }

  /** Clean up stale in-memory state for a session whose process is gone. */
  async function cleanupStaleSession(sessionId: string): Promise<void> {
    console.log(`[session] cleaning up stale session: sessionId=${sessionId}`);
    state.sessionContexts.delete(sessionId);
    state.turnStates.delete(sessionId);
    state.sessionSubagents.delete(sessionId);
    state.sessionTasks.delete(sessionId);
    state.sessionHasTodoWrite.delete(sessionId);
    state.sessionToolUses.delete(sessionId);
    state.sessionModels.delete(sessionId);
    state.sessionContextTokens.delete(sessionId);
    state.sessionLastTool.delete(sessionId);
    state.sessionAgentToolUseIds.delete(sessionId);
    state.sessionProviders.delete(sessionId);
    state.sessionSubstantiveOutput.delete(sessionId);
    const now = new Date().toISOString();
    await db.update(sessions)
      .set({ status: "stopped", endedAt: now })
      .where(eq(sessions.id, sessionId));
    // Also reset workspace status to idle
    const sessionRows = await db.select({ workspaceId: sessions.workspaceId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (sessionRows.length > 0) {
      await db.update(workspaces)
        .set({ status: "idle", updatedAt: now })
        .where(eq(workspaces.id, sessionRows[0].workspaceId));
    }
  }

  /**
   * Reattach to a surviving agent session after server restart.
   * Restores in-memory state so broadcast(), activity, and exit handling work.
   */
  function reattachSession(opts: {
    sessionId: string;
    workspaceId: string;
    issueId: string;
    projectId: string;
    providerName?: string;
  }): void {
    const { sessionId, workspaceId, issueId, projectId, providerName } = opts;
    state.sessionContexts.set(sessionId, { workspaceId, issueId, projectId });
    if (providerName) state.sessionProviders.set(sessionId, providerName);
    console.log(`[session] reattached: sessionId=${sessionId} workspaceId=${workspaceId} provider=${providerName ?? "unknown"}`);
  }

  /**
   * Notify that an externally-monitored session's process has exited.
   * Mirrors the exit handling in startSession's onOutput callback.
   */
  async function notifyExternalExit(sessionId: string, exitCode: number | null): Promise<void> {
    const ctx = state.sessionContexts.get(sessionId);
    // Clear in-memory state
    state.sessionContexts.delete(sessionId);
    state.turnStates.delete(sessionId);
    state.sessionProviders.delete(sessionId);
    state.sessionSubagents.delete(sessionId);
    state.sessionTasks.delete(sessionId);
    state.sessionHasTodoWrite.delete(sessionId);
    state.sessionToolUses.delete(sessionId);
    state.sessionModels.delete(sessionId);
    state.sessionContextTokens.delete(sessionId);
    state.sessionLastTool.delete(sessionId);
    state.sessionAgentToolUseIds.delete(sessionId);
    state.sessionTextParts.delete(sessionId);
    state.sessionFinalText.delete(sessionId);
    state.sessionSubstantiveOutput.delete(sessionId);
    state.sessionExitPlanModeDenied.delete(sessionId);

    // Clear activity and todos for this session
    if (ctx) {
      options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
      options?.onTodos?.(ctx.projectId, ctx.issueId, []);
    }

    // Update DB
    const now = new Date().toISOString();
    await db.update(sessions)
      .set({ status: "completed", endedAt: now, exitCode: String(exitCode ?? 0) })
      .where(eq(sessions.id, sessionId));

    // Fire workflow callback
    const wsId = ctx?.workspaceId;
    if (wsId) {
      options?.onSessionExit?.(wsId, sessionId, exitCode, false);
    }
  }

  return {
    startSession,
    stopSession,
    sendTurn,
    getTurnState,
    isProcessAlive,
    cleanupStaleSession,
    reattachSession,
    notifyExternalExit,
  };
}
