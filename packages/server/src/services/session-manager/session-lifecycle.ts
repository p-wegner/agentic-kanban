import { db as realDb } from "../../db/index.js";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../../db/index.js";
import { randomUUID } from "node:crypto";
import * as lifecycleRepo from "../../repositories/session-lifecycle.repository.js";
import * as agentSkillRepo from "../../repositories/agent-skill.repository.js";
import * as realAgentService from "../agent.service.js";
import { extractPlanFromMessages } from "../plan-mode.service.js";
import { computeScorecard } from "../workspace-scorecard.service.js";
import { computeWorkspaceCodeMetrics } from "../workspace-code-metrics.service.js";
import { recordAgentProfileLaunchFailure } from "../agent-profile-health.service.js";
import { emitButlerSystemEvent } from "../butler-event-feed.js";
import type { ProviderName } from "../agent-provider.js";
import { narrowProviderName } from "../agent-provider.js";
import { getProviderExitBehavior } from "../agent-provider/provider-exit-behavior.js";
import type { RotationRings } from "../agent-provider/provider-exit-behavior.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { modelBelongsToProvider } from "@agentic-kanban/shared";
import type { SessionManagerOptions, SessionState, StartSessionOptions } from "./types.js";
import { workspaceLaunchPreflight } from "../preflight-check.js";
import { provisionContainerForWorkspace } from "../devcontainer-workspace.service.js";
import type { ContainerProvision } from "../devcontainer-workspace.service.js";
import { WorkspaceError } from "../workspace-internals.js";
import { DEFAULT_BUILDER_GUARDRAILS, PREF_BUILDER_GUARDRAILS } from "../../constants/preference-keys.js";
import { parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import { loadCodexLicenseRing } from "../codex-license-ring.js";
import { loadClaudeSubscriptionRing } from "../claude-subscription-ring.js";
import {
  classifySessionExit as classifySessionExitRoute,
  extractCapturedStderr,
  ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS as EXIT_WINDOW_MS,
} from "./session-exit-state-machine.js";
import {
  buildZeroOutputLaunchFailureStats,
  buildModelErrorLaunchFailureStats,
  buildStaleResumeLaunchFailureStats,
  buildCodexUsageLimitStats,
  buildClaudeUsageLimitStats,
  buildIndeterminateExitStats,
} from "./session-exit-stats.js";
import {
  CODEX_SPARK_MODEL,
  CODEX_SAFE_DEFAULT_MODEL,
  isBuilderSession,
  buildStaleResumeHandoffPrompt,
  instructionFingerprint,
  mergeExistingSessionStats,
  lifecycleProviderName,
} from "./session-launch-helpers.js";
import { finalizePlanModeExit } from "./plan-mode-exit.js";

/** Bounds the missing-transcript fallback (#26) to one automatic retry per workspace. */
const MAX_STALE_RESUME_RECOVERIES = 1;

/** Subset of agent.service that the lifecycle depends on. Injectable for tests. */
export type AgentService = typeof realAgentService;

/** Injectable dependencies for the session lifecycle (default to the real singletons). */
export interface SessionLifecycleDeps {
  db?: Database;
  agentService?: AgentService;
  preflight?: typeof workspaceLaunchPreflight;
}

/** Re-exported from the exit state machine, which now owns the canonical value. */
export const ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS = EXIT_WINDOW_MS;

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
      skipLaunchPreflight,
      skipPermissions: skipPermissionsOpt,
      systemInstructions,
    } = opts;

    // Look up workspace to get workingDir
    const workspace = await lifecycleRepo.getWorkspaceById(workspaceId, db);
    if (!workspace) throw new Error("Workspace not found");
    // Per-call model wins; otherwise inherit the model stored on the workspace so resume/
    // review/follow-up sessions stay on the same model the workspace was created with.
    // Guard: if workspace.model is a cross-provider id (e.g. gpt-5.5 baked into a claude
    // workspace), drop it rather than passing an invalid --model flag (#698/#696).
    const providerName: ProviderName = lifecycleProviderName(provider, profile);
    const workspaceModelSafe = (workspace.model && modelBelongsToProvider(workspace.model, providerName))
      ? workspace.model
      : undefined;
    const resolvedModel = model ?? workspaceModelSafe ?? undefined;
    const builderSession = isBuilderSession(triggerType, planMode);
    let effectiveModel = resolvedModel;
    if (providerName === "codex") {
      if ((effectiveModel ?? "").trim() === CODEX_SPARK_MODEL) {
        const message =
          `Refusing to launch Codex builder session with hostile model ${CODEX_SPARK_MODEL}; ` +
          `choose a safe Codex model such as ${CODEX_SAFE_DEFAULT_MODEL}.`;
        if (builderSession) {
          throw new WorkspaceError(message, "CONFLICT", {
            code: "UNSAFE_CODEX_MODEL",
            model: CODEX_SPARK_MODEL,
          });
        }
        console.warn(`[session] WARNING: ${message}`);
      } else if (!effectiveModel && builderSession) {
        effectiveModel = CODEX_SAFE_DEFAULT_MODEL;
        console.warn(
          `[session] Codex builder launch has no explicit model; using ${CODEX_SAFE_DEFAULT_MODEL} ` +
          "instead of relying on CODEX_HOME config.toml.",
        );
      }
    }
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
    const projectId = (await lifecycleRepo.getIssueProjectId(workspace.issueId, db)) ?? "";

    if (!skipLaunchPreflight && !workspace.isDirect && !workingDirOverride && projectId) {
      const project = await lifecycleRepo.getProjectPreflightInfo(projectId, db);
      if (project?.repoPath) {
        const preflight = await launchPreflight({
          repoPath: project.repoPath,
          worktreePath: effectiveWorkingDir,
          baseBranch: workspace.baseBranch || project.defaultBranch,
          branch: workspace.branch,
          isDirect: workspace.isDirect ?? false,
          symlinkDirs: project.symlinkEnabled ? parseSymlinkDirs(project.symlinkDirs) : [],
        });
        if (!preflight.ok) {
          throw new WorkspaceError(preflight.errors.join("\n"), "CONFLICT", {
            code: "STALE_SAFETY_POLICY",
            staleFiles: preflight.staleFiles,
          });
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
      const prev = await lifecycleRepo.getPrevSessionResumeInfo(resumeFromId, db);
      if (prev && prev.providerSessionId && prev.executor === executor) {
        // Skip mock agent session IDs (e.g. "mock-session-xxx") — they are not resumable
        const sid = prev.providerSessionId;
        if (!sid.startsWith("mock-session-")) {
          providerSessionId = sid;
          console.log(`[session] resuming: resumeFromId=${resumeFromId} providerSessionId=${providerSessionId}`);
        } else {
          console.log(`[session] skipping resume: providerSessionId=${sid} is a mock session ID`);
        }
      } else if (prev && prev.providerSessionId) {
        console.log(`[session] skipping resume: previous executor=${prev.executor} current executor=${executor}`);
      }
    }

    const sessionId = randomUUID();
    const now = new Date().toISOString();
    console.log(`[session] starting: workspaceId=${workspaceId} sessionId=${sessionId} workingDir=${effectiveWorkingDir}`);

    // Capture the skill the workspace launched under so Insights "By Skill" can
    // attribute this session even if the workspace's skill changes later. The name
    // is snapshotted because the agent_skills row may be renamed or deleted.
    const sessionSkillId: string | null = workspace.skillId ?? null;
    let sessionSkillName: string | null = null;
    if (sessionSkillId) {
      const skillRow = await agentSkillRepo.getAgentSkillById(sessionSkillId, db);
      sessionSkillName = skillRow?.name ?? null;
    }

    // Cache session context for activity broadcasting
    state.sessionContexts.set(sessionId, { workspaceId, issueId: workspace.issueId, projectId });
    if (multiTurn) {
      state.turnStates.set(sessionId, "processing");
    }

    const guardrailValue = await lifecycleRepo.getPreferenceValue(PREF_BUILDER_GUARDRAILS, db);
    let effectiveSystemInstructions =
      systemInstructions === undefined
        ? (guardrailValue === undefined ? DEFAULT_BUILDER_GUARDRAILS : guardrailValue)
        : systemInstructions;
    if (executor === "codex" && builderSession) {
      // Codex always augments (and never drops) the instructions, so the result is a string.
      effectiveSystemInstructions =
        getProviderExitBehavior("codex").injectBuilderInstructions(effectiveSystemInstructions) ?? effectiveSystemInstructions;
    }
    const launchDiagnostics = {
      launch: {
        provider: executor,
        profile: profile?.name ?? claudeProfile ?? null,
        resolvedModel: effectiveModel ?? null,
        requestedModel: model ?? null,
        workspaceModel: workspace.model ?? null,
        triggerType: triggerType ?? null,
        systemInstructionsFingerprint: instructionFingerprint(effectiveSystemInstructions),
      },
    };

    await lifecycleRepo.insertSession({
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
      stats: JSON.stringify(launchDiagnostics),
    }, db);
    state.sessionProviders.set(sessionId, executor);

    // Determine skip_permissions: explicit opt takes priority over global preference.
    const skipPermRows = await lifecycleRepo.getSkipPermissionsRows(db);
    const dbSkipPerms = parseBoolSetting("skip_permissions", skipPermRows[0]?.value);
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

    // Codex OAuth licenses: a ChatGPT-plan license is a separate CODEX_HOME directory
    // with its own auth.json — selected by an auto-discovered `~/.codex-<name>` dir or
    // a rotation-ring entry. Point CODEX_HOME at it and DROP the profile name from the
    // launch (a separate home has no `[profiles.<name>]`, so `--profile` would make
    // codex exit code 2). Plain toml / API-key (configToml) profiles resolve to no
    // home and keep `--profile`.
    let effectiveExtraEnv = extraEnv;
    let launchProfile = profile;
    if (profile?.provider === "codex" && profile.name && profile.name !== "default") {
      try {
        const rings: RotationRings = { codex: await loadCodexLicenseRing(db) };
        const rotation = getProviderExitBehavior("codex").resolveConfigDir(profile.name, rings);
        if (rotation) {
          effectiveExtraEnv = { ...effectiveExtraEnv, [rotation.envVar]: rotation.dir };
          launchProfile = { provider: "codex", name: "default" };
          console.log(`[session] codex license '${profile.name}' -> ${rotation.envVar}=${rotation.dir} (--profile suppressed)`);
        }
      } catch (err) {
        console.warn("[session] codex license ring resolution failed (non-fatal):", err instanceof Error ? err.message : String(err));
      }
    }
    // Claude OAuth subscriptions: a Max/Pro-plan login is a separate CLAUDE_CONFIG_DIR
    // directory with its own `.credentials.json` — selected by an auto-discovered
    // `~/.claude-<name>` dir or a rotation-ring entry. Point CLAUDE_CONFIG_DIR at it and
    // DROP the settings-profile name from the launch (a separate config dir has no
    // `settings_<name>.json`, and it authenticates via its own login). Plain
    // settings-file / API-key (settingsProfile) profiles resolve to no dir and keep
    // `--settings`. Mirrors the codex CODEX_HOME path above.
    if (profile?.provider === "claude" && profile.name && profile.name !== "default" && profile.name !== "mock") {
      try {
        const rings: RotationRings = { claude: await loadClaudeSubscriptionRing(db) };
        const rotation = getProviderExitBehavior("claude").resolveConfigDir(profile.name, rings);
        if (rotation) {
          effectiveExtraEnv = { ...effectiveExtraEnv, [rotation.envVar]: rotation.dir };
          launchProfile = { provider: "claude", name: "default" };
          console.log(`[session] claude subscription '${profile.name}' -> ${rotation.envVar}=${rotation.dir} (--settings suppressed)`);
        }
      } catch (err) {
        console.warn("[session] claude subscription ring resolution failed (non-fatal):", err instanceof Error ? err.message : String(err));
      }
    }

    // ── Exit state-machine terminal handlers ──────────────────────────────────
    // The drain → classify → finalize → continue machine. `drain` (output-to-EOF,
    // #909) happens in agent.service BEFORE it emits the exit event; `classify` is
    // the pure `classifySessionExitRoute` over an explicit SessionExitContext;
    // these handlers are `finalize`/`continue` — they own the side effects (DB
    // writes, HANDOFF.md, relaunch) for each route. Provider-specific knowledge
    // (which usage limit was hit) comes from the provider's exit behavior.

    /** usage-limit route: persist rate-limit stats and block the workspace for rotation. */
    function finalizeUsageLimitExit(
      route: Extract<ReturnType<typeof classifySessionExitRoute>, { phase: "usage-limit" }>,
      endNow: string,
      durationMs: number,
      exitCode: number | null,
    ): void {
      const { usageLimit, effectiveExitCode } = route;
      const stats = usageLimit.kind === "codex"
        ? buildCodexUsageLimitStats(executor, durationMs, exitCode, usageLimit.message, usageLimit.retryAfter)
        : buildClaudeUsageLimitStats(executor, durationMs, exitCode, usageLimit.message, usageLimit.retryAfter);
      void (async () => {
        await recordAgentProfileLaunchFailure(db, {
          provider: lifecycleProviderName(provider, profile),
          profileName: profile?.name,
          summary: stats.failureReason,
          exitCode: effectiveExitCode,
          sessionId,
          workspaceId,
          at: endNow,
        });
        const mergedStats = await mergeExistingSessionStats(db, sessionId, stats);
        await lifecycleRepo.updateSessionStoppedWithStats(sessionId, endNow, String(effectiveExitCode), JSON.stringify(mergedStats), db);
        await lifecycleRepo.updateWorkspaceStatus(workspaceId, "blocked", endNow, db);
        console.warn(
          `[agent] ${usageLimit.kind}-rate-limited: sessionId=${sessionId} workspace=${workspaceId}` +
          `${usageLimit.retryAfter ? ` retryAfter=${usageLimit.retryAfter}` : ""}`,
        );
      })()
        .catch((err) => console.error(`Failed to record ${usageLimit.kind} usage-limit launch failure:`, err))
        .finally(() => options?.onSessionExit?.(workspaceId, sessionId, effectiveExitCode, planMode));
    }

    /**
     * launch-failure route: a fast zero-output crash or a non-zero exit with error text.
     *
     * Special-cased sub-route: a resumed launch whose error text names a missing provider
     * transcript ("No conversation found with session ID: <uuid>" for Claude — volume
     * deleted, ~/.claude pruned, image rebuild without the state volume). The butler SDK
     * path already recovers from this (`isStaleResumeError` in butler-sdk.service.ts);
     * workspace agents did not, so a stale `--resume` used to be reported as a plain
     * launch failure and left the workspace idle awaiting a manual relaunch. Instead: clear
     * the dead provider session id so it can't be forwarded again, and relaunch fresh with
     * a handoff note — bounded to one automatic retry per workspace so a launch failure for
     * an unrelated reason can't loop.
     */
    function finalizeLaunchFailureExit(
      route: Extract<ReturnType<typeof classifySessionExitRoute>, { phase: "launch-failure" }>,
      endNow: string,
      durationMs: number,
      exitCode: number | null,
      capturedStderr: string,
    ): void {
      const { isZeroOutput, isNonZeroExit, effectiveExitCode, errorText } = route;
      const usedProviderSessionId = resumeWithNewModel ? undefined : providerSessionId;
      const staleResumeRecoveryCount = state.workspaceStaleResumeRecoveryCount.get(workspaceId) ?? 0;
      const isStaleResume =
        Boolean(usedProviderSessionId) &&
        staleResumeRecoveryCount < MAX_STALE_RESUME_RECOVERIES &&
        getProviderExitBehavior(narrowProviderName(executor)).isStaleResumeError(errorText || capturedStderr);

      const stats = isStaleResume
        ? buildStaleResumeLaunchFailureStats(executor, durationMs, exitCode, errorText || capturedStderr)
        : isZeroOutput
          ? buildZeroOutputLaunchFailureStats(executor, durationMs, exitCode, capturedStderr)
          : buildModelErrorLaunchFailureStats(executor, durationMs, exitCode, errorText);

      const sessionFinalized = (async () => {
        await recordAgentProfileLaunchFailure(db, {
          provider: lifecycleProviderName(provider, profile),
          profileName: profile?.name,
          summary: stats.failureReason,
          exitCode: effectiveExitCode,
          sessionId,
          workspaceId,
          at: endNow,
        });
        const mergedStats = await mergeExistingSessionStats(db, sessionId, stats);
        await lifecycleRepo.updateSessionStoppedWithStats(sessionId, endNow, String(effectiveExitCode), JSON.stringify(mergedStats), db);
        await lifecycleRepo.insertSessionMessage({
          sessionId,
          type: "stderr",
          data: stats.failureReason,
          exitCode: null,
        }, db);
        if (isStaleResume) {
          if (resumeFromId) await lifecycleRepo.clearProviderSessionId(resumeFromId, db);
        } else {
          await lifecycleRepo.updateWorkspaceStatus(workspaceId, "idle", endNow, db);
        }
        if (projectId) {
          emitButlerSystemEvent({
            projectId,
            kind: "session_failed",
            workspaceId,
            text: isStaleResume
              ? `Agent resume failed for workspace ${workspaceId}: the previous conversation transcript was missing. Clearing the stale resume id and relaunching fresh.`
              : isNonZeroExit
                ? `Agent launch failed for workspace ${workspaceId}: exited with code ${effectiveExitCode} in ${Math.round(durationMs / 1000)}s${errorText ? ` — ${errorText.slice(0, 200)}` : ""}.`
                : `Agent launch failed for workspace ${workspaceId}: zero output within ${Math.round(durationMs / 1000)}s.`,
          });
        }
      })()
        .catch((err) => console.error("Failed to record launch failure:", err));

      void sessionFinalized.finally(() => options?.onSessionExit?.(workspaceId, sessionId, effectiveExitCode, planMode));

      if (isStaleResume) {
        state.workspaceStaleResumeRecoveryCount.set(workspaceId, staleResumeRecoveryCount + 1);
        sessionFinalized.finally(() => startSession({
          workspaceId,
          prompt: buildStaleResumeHandoffPrompt(prompt),
          agentCommand,
          agentArgs: effectiveAgentArgs,
          resumeFromId: sessionId,
          claudeProfile,
          multiTurn,
          permissionPromptTool,
          planMode,
          provider,
          triggerType: triggerType ?? "agent",
          profile,
          model,
          systemInstructions,
          contextFiles,
          extraEnv,
          workingDirOverride,
          skipPermissions: skipPermissionsOpt,
        })).catch((err) => console.error(`[session] stale-resume relaunch failed: workspaceId=${workspaceId}`, err));
      }
    }

    /**
     * completed route: a real run finished. finalize (DB + HANDOFF.md), then the
     * continuations — ExitPlanMode auto-resume and plan-mode plan persistence.
     */
    function finalizeCompletedExit(
      endNow: string,
      exitCode: number | null,
      hadExitPlanModeDenied: boolean,
      planText: string | null,
    ): void {
      const sessionFinalized = (async () => {
        await lifecycleRepo.updateSessionCompleted(sessionId, endNow, String(exitCode ?? 0), db);

        // Write HANDOFF.md before workflow callbacks can launch the next session.
        if (effectiveWorkingDir) {
          try {
            const { writeHandoffFile } = await import("../handoff.service.js");
            await writeHandoffFile(effectiveWorkingDir, sessionId, db, workspace.baseBranch, workspaceId);
            console.log(`[session] HANDOFF.md written: workspaceId=${workspaceId} sessionId=${sessionId}`);
          } catch (err) {
            console.warn(`[session] HANDOFF.md write failed: sessionId=${sessionId}`, err);
          }
        }
      })()
        .catch((err) => console.error("Failed to finalize session:", err));
      void sessionFinalized.finally(() => {
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

      // All-provider plan mode: a read-only plan run just finished. The handler now
      // runs whenever the session was launched in plan mode — NOT only when a plan was
      // captured — so a plan-mode run can never silently leave the workspace parked with
      // planMode stuck true (which made every follow-up turn re-run read-only/plan-only,
      // the #924 strand). Three outcomes, all of which CLEAR planMode and leave a visible
      // state:
      //   1. plan extracted → write PLAN.md, then auto-continue or park awaiting approval.
      //   2. no plan / non-zero exit → mark the workspace blocked (needs-attention).
      if (planMode) {
        void sessionFinalized.then(() =>
          finalizePlanModeExit(
            workspaceId,
            exitCode,
            planText,
            {
              agentCommand,
              agentArgs: effectiveAgentArgs,
              claudeProfile,
              permissionPromptTool,
              provider,
              profile,
            },
            { db, workspaceWorkingDir: workspace.workingDir, projectId, startSession },
          ),
        );
      }
    }

    /**
     * The exit-event orchestrator. Dedup → teardown in-memory state → build the
     * explicit SessionExitContext → classify → dispatch to the matching terminal
     * handler. The provider exit behavior supplies the usage-limit detection so
     * this stays free of `executor === ...` provider branches.
     */
    function handleExitEvent(exitCode: number | null): void {
      // teardown: always clean up in-memory state regardless of DB result
      state.sessionContexts.delete(sessionId);
      state.turnStates.delete(sessionId);
      state.sessionProviders.delete(sessionId);
      const hadExitPlanModeDenied = state.sessionExitPlanModeDenied.delete(sessionId);

      const stoppedByUser = state.stoppedByUser.has(sessionId);
      const messages = state.messageBuffer.get(sessionId) ?? [];
      const capturedFinalText = state.sessionFinalText.get(sessionId) ?? null;
      // Plan text for a plan-mode run is the STRICT marker block scanned out of the RAW
      // message buffer (#924) — provider-agnostic, and never marker-less chatter. Codex's
      // final agent_message was observed to slip past `sessionFinalText`, leaving the
      // parser-captured text empty; scanning the raw stdout recovers the
      // `===PLAN BEGIN/END===` block regardless of which fields the parser populated. When
      // NO marker block exists, this is null and the workspace is surfaced as needs-attention
      // rather than auto-continuing on unrelated text. Non-plan runs keep the captured text.
      const planText = planMode ? extractPlanFromMessages(messages) : capturedFinalText;
      const hadSubstantiveOutput =
        state.sessionSubstantiveOutput.has(sessionId) ||
        Boolean((planText ?? capturedFinalText)?.trim().length);
      // teardown of the per-session text/output flags (consumed above)
      state.stoppedByUser.delete(sessionId);
      state.sessionFinalText.delete(sessionId);
      state.sessionSubstantiveOutput.delete(sessionId);

      const endNow = new Date().toISOString();
      const durationMs = Math.max(0, new Date(endNow).getTime() - new Date(now).getTime());
      const capturedStderr = extractCapturedStderr(messages);
      // Provider-owned usage-limit detection (codex license / claude subscription).
      // Key on the EXECUTOR (the actual launched provider id), matching the original
      // `executor === "codex"` / `executor === "claude-code"` branches exactly.
      const usageLimit = getProviderExitBehavior(narrowProviderName(executor)).detectUsageLimit(messages);

      const route = classifySessionExitRoute({
        exitCode,
        durationMs,
        hadSubstantiveOutput,
        stoppedByUser,
        usageLimit,
        planText,
        capturedStderr,
      });

      switch (route.phase) {
        case "stopped":
          // Skip DB update — stopSession already wrote "stopped".
          options?.onSessionExit?.(workspaceId, sessionId, exitCode, planMode);
          return;
        case "usage-limit":
          finalizeUsageLimitExit(route, endNow, durationMs, exitCode);
          return;
        case "launch-failure":
          finalizeLaunchFailureExit(route, endNow, durationMs, exitCode, capturedStderr);
          return;
        case "completed":
          finalizeCompletedExit(endNow, exitCode, hadExitPlanModeDenied, planText);
          return;
      }
    }

    // Provision the builder's devcontainer BEFORE the (synchronous) spawn. This
    // is best-effort by contract — any missing prerequisite resolves to
    // undefined and the agent launches on the host as before.
    let containerProvision: ContainerProvision | undefined;
    try {
      const devcontainerEnabled = parseBoolSetting(
        "devcontainer_builders",
        await lifecycleRepo.getPreferenceValue("devcontainer_builders", db),
      );
      if (devcontainerEnabled) {
        // Only read the project when the feature is on — this is the default-off
        // path for every launch, and it should not pay for a lookup it won't use.
        const projectInfo = projectId ? await lifecycleRepo.getProjectPreflightInfo(projectId, db) : null;
        containerProvision = await provisionContainerForWorkspace({
          enabled: true,
          worktreePath: effectiveWorkingDir,
          workspaceId,
          symlinkDirs: projectInfo?.symlinkEnabled ? projectInfo.symlinkDirs : null,
          // Seed the narrow container profile from whatever this launch actually
          // authenticates with (#133). An OAuth subscription resolved above put its
          // CLAUDE_CONFIG_DIR in effectiveExtraEnv and reset launchProfile to
          // "default"; a settings-file profile keeps its name and needs its
          // settings_<name>.json seeded too.
          claudeProfile: profile?.name ?? "default",
          claudeConfigDir: effectiveExtraEnv?.CLAUDE_CONFIG_DIR,
          settingsProfile: launchProfile?.name !== "default" ? launchProfile?.name : undefined,
        });
      }
    } catch (err) {
      console.warn(`[devcontainer] provisioning threw for sessionId=${sessionId} — running on host`, err);
    }

    try {
      const proc = agentService.launch(effectiveWorkingDir, sessionId, effectivePrompt, effectiveAgentArgs, (event) => {
        if (event.type === "exit") {
          if (state.sessionExitHandled.has(sessionId)) {
            console.warn(`[session] duplicate exit ignored: sessionId=${sessionId}`);
            return;
          }
          state.sessionExitHandled.add(sessionId);
        }

        const message: AgentOutputMessage = event;
        broadcast(sessionId, message);

        if (event.type === "exit") {
          handleExitEvent(event.exitCode ?? null);
        }
      // When resumeWithNewModel is true, omit --resume so the new profile/provider is used instead
      }, resumeWithNewModel ? undefined : providerSessionId, agentCommand, claudeProfile, multiTurn, permissionPromptTool, planMode, provider, launchProfile, effectiveExtraEnv, skipPermissions, effectiveModel, contextFiles, (effectiveSystemInstructions ?? "").trim() || undefined, containerProvision);

      // Persist PID so hot-reload can detect surviving processes
      if (proc.pid) {
        lifecycleRepo.updateSessionPid(sessionId, proc.pid, db)
          .catch((err) => console.error("Failed to store session pid:", err));
      }
    } catch (err) {
      await recordAgentProfileLaunchFailure(db, {
        provider: lifecycleProviderName(provider, profile),
        profileName: profile?.name,
        summary: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        sessionId,
        workspaceId,
      }).catch(() => {});
      // Clean up zombie session state if launch failed
      state.sessionContexts.delete(sessionId);
      state.turnStates.delete(sessionId);
      state.sessionProviders.delete(sessionId);
      state.sessionSubstantiveOutput.delete(sessionId);
      state.sessionExitHandled.delete(sessionId);
      await lifecycleRepo.updateSessionStoppedNoStats(sessionId, new Date().toISOString(), db)
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
    // Cancel any pending DB flush timer; the exit event from the kill will trigger a final flush
    const stopTimer = state.dbWriteTimers.get(sessionId);
    if (stopTimer !== undefined) {
      clearTimeout(stopTimer);
      state.dbWriteTimers.delete(sessionId);
    }
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
    await lifecycleRepo.updateSessionStoppedNoStats(sessionId, now, db);
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
    const pendingTimer = state.dbWriteTimers.get(sessionId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      state.dbWriteTimers.delete(sessionId);
    }
    state.dbWriteBuffer.delete(sessionId);
    const now = new Date().toISOString();
    await lifecycleRepo.updateSessionStoppedNoStats(sessionId, now, db);
    // Also reset workspace status to idle
    const sessionRow = await lifecycleRepo.getSessionWorkspaceId(sessionId, db);
    if (sessionRow) {
      await lifecycleRepo.updateWorkspaceStatus(sessionRow.workspaceId, "idle", now, db);
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
    if (state.sessionExitHandled.has(sessionId)) {
      console.warn(`[session] duplicate external exit ignored: sessionId=${sessionId}`);
      return;
    }
    state.sessionExitHandled.add(sessionId);

    // Capture the in-memory exit signals BEFORE teardown so this exit can still be classified.
    // A reattached agent may have streamed a usage-limit / crash message after the restart; if we
    // dropped these we'd lose the only observable signal and misfile every external exit (review §3.2).
    const bufferedMessages = state.messageBuffer.get(sessionId) ?? [];
    const capturedFinalText = state.sessionFinalText.get(sessionId) ?? null;
    const hadSubstantiveOutput =
      state.sessionSubstantiveOutput.has(sessionId) || Boolean(capturedFinalText?.trim().length);
    const stoppedByUser = state.stoppedByUser.has(sessionId);
    const providerFromState = state.sessionProviders.get(sessionId);

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
    state.stoppedByUser.delete(sessionId);
    state.messageBuffer.delete(sessionId);
    const externalExitTimer = state.dbWriteTimers.get(sessionId);
    if (externalExitTimer !== undefined) {
      clearTimeout(externalExitTimer);
      state.dbWriteTimers.delete(sessionId);
    }
    state.dbWriteBuffer.delete(sessionId);

    const existing = await lifecycleRepo.getSessionStatus(sessionId, db);
    if (!existing || existing.status !== "running") {
      console.warn(`[session] external exit ignored for non-running session: sessionId=${sessionId}`);
      return;
    }

    // Clear activity and todos for this session
    if (ctx) {
      options?.onActivity?.(ctx.projectId, ctx.issueId, sessionId, "");
      options?.onTodos?.(ctx.projectId, ctx.issueId, []);
    }

    const now = new Date().toISOString();
    const wsId = ctx?.workspaceId;
    const executor = providerFromState ?? existing.executor ?? "claude-code";
    const providerName = lifecycleProviderName(executor);
    // A reattached session started before the restart, so its duration is large — outside the
    // launch-failure window, exactly as a genuine long-running agent should be.
    const startedAtMs = existing.startedAt ? new Date(existing.startedAt).getTime() : Date.now();
    const durationMs = Math.max(0, new Date(now).getTime() - startedAtMs);
    const capturedStderr = extractCapturedStderr(bufferedMessages);
    const usageLimit = getProviderExitBehavior(providerName).detectUsageLimit(bufferedMessages);

    // Route the external exit through the SAME classifier the live exit path uses, instead of the
    // old raw `String(exitCode ?? 0)` shortcut that recorded every external exit as completed/"0".
    // `exitCodeKnown: false` when the PID poll never observed a code (the reattach default).
    const route = classifySessionExitRoute({
      exitCode,
      durationMs,
      hadSubstantiveOutput,
      stoppedByUser,
      usageLimit,
      planText: capturedFinalText,
      capturedStderr,
      exitCodeKnown: exitCode !== null,
    });

    const fireExit = (code: number | null) => {
      if (wsId) options?.onSessionExit?.(wsId, sessionId, code, false);
    };
    const recordProfileFailure = (summary: string, code: number | null) =>
      recordAgentProfileLaunchFailure(db, {
        provider: providerName,
        summary,
        exitCode: code,
        sessionId,
        workspaceId: wsId ?? undefined,
        at: now,
      }).catch((err) => console.error("Failed to record external-exit profile failure:", err));

    switch (route.phase) {
      case "stopped":
        // The user stopped it; stopSession already wrote "stopped". Just fire the callback.
        fireExit(exitCode);
        return;
      case "usage-limit": {
        const { usageLimit: ul, effectiveExitCode } = route;
        const stats = ul.kind === "codex"
          ? buildCodexUsageLimitStats(executor, durationMs, exitCode, ul.message, ul.retryAfter)
          : buildClaudeUsageLimitStats(executor, durationMs, exitCode, ul.message, ul.retryAfter);
        await recordProfileFailure(stats.failureReason, effectiveExitCode);
        const mergedStats = await mergeExistingSessionStats(db, sessionId, stats);
        await lifecycleRepo.updateSessionStoppedWithStats(sessionId, now, String(effectiveExitCode), JSON.stringify(mergedStats), db);
        if (wsId) await lifecycleRepo.updateWorkspaceStatus(wsId, "blocked", now, db);
        console.warn(`[agent] ${ul.kind}-rate-limited on external exit: sessionId=${sessionId} workspace=${wsId ?? "?"}`);
        fireExit(effectiveExitCode);
        return;
      }
      case "launch-failure": {
        const { isZeroOutput, isNonZeroExit, effectiveExitCode, errorText } = route;
        const stats = isZeroOutput
          ? buildZeroOutputLaunchFailureStats(executor, durationMs, exitCode, capturedStderr)
          : buildModelErrorLaunchFailureStats(executor, durationMs, exitCode, errorText);
        await recordProfileFailure(stats.failureReason, effectiveExitCode);
        const mergedStats = await mergeExistingSessionStats(db, sessionId, stats);
        await lifecycleRepo.updateSessionStoppedWithStats(sessionId, now, String(effectiveExitCode), JSON.stringify(mergedStats), db);
        await lifecycleRepo.insertSessionMessage({ sessionId, type: "stderr", data: stats.failureReason, exitCode: null }, db);
        if (wsId) await lifecycleRepo.updateWorkspaceStatus(wsId, "idle", now, db);
        if (ctx?.projectId && wsId) {
          emitButlerSystemEvent({
            projectId: ctx.projectId,
            kind: "session_failed",
            workspaceId: wsId,
            text: isNonZeroExit
              ? `Agent launch failed for workspace ${wsId}: exited with code ${effectiveExitCode}.`
              : `Agent launch failed for workspace ${wsId}: zero output.`,
          });
        }
        fireExit(effectiveExitCode);
        return;
      }
      case "unknown-exit": {
        // The exit code was never observed (reattached PID vanished after a restart). Record a
        // distinct indeterminate terminal — status "stopped", exitCode NULL, stats flagged
        // indeterminate — so a post-restart crash/quota-exhaustion is never logged as a clean "0".
        const stats = buildIndeterminateExitStats(executor, durationMs, route.hadSubstantiveOutput, route.capturedStderr);
        const mergedStats = await mergeExistingSessionStats(db, sessionId, stats);
        await lifecycleRepo.updateSessionStoppedWithStats(sessionId, now, null, JSON.stringify(mergedStats), db);
        if (ctx?.projectId && wsId) {
          emitButlerSystemEvent({
            projectId: ctx.projectId,
            kind: "session_failed",
            workspaceId: wsId,
            text: `Agent session for workspace ${wsId} ended with an indeterminate exit after a server restart — its real exit code could not be observed. Recorded as indeterminate (not a verified success).`,
          });
        }
        console.warn(`[agent] external exit indeterminate (exit code unobserved): sessionId=${sessionId} workspace=${wsId ?? "?"}`);
        fireExit(exitCode); // exitCode is null — the workflow callback must NOT see a fabricated 0
        return;
      }
      case "completed":
        // A genuine, OBSERVED exit code (someone passed a real code, e.g. 0). Preserve it.
        await lifecycleRepo.updateSessionCompleted(sessionId, now, String(route.exitCode ?? 0), db);
        fireExit(exitCode);
        return;
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
