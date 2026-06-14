import { db as realDb } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import { sessions, sessionMessages, workspaces, issues, projects, preferences, agentSkills } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import * as realAgentService from "../agent.service.js";
import { extractPlan, writePlanFile, buildImplementPrompt } from "../plan-mode.service.js";
import { getHarnessBoolSetting } from "../harness-settings.js";
import { computeScorecard } from "../workspace-scorecard.service.js";
import { computeWorkspaceCodeMetrics } from "../workspace-code-metrics.service.js";
import { recordAgentProfileLaunchFailure } from "../agent-profile-health.service.js";
import { emitButlerSystemEvent } from "../butler-event-feed.js";
import type { ProviderName } from "../agent-provider.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { modelBelongsToProvider } from "@agentic-kanban/shared";
import type { SessionManagerOptions, SessionState, StartSessionOptions } from "./types.js";
import { workspaceLaunchPreflight } from "../preflight-check.js";
import { WorkspaceError } from "../workspace-internals.js";
import { DEFAULT_BUILDER_GUARDRAILS, PREF_BUILDER_GUARDRAILS } from "../../constants/preference-keys.js";
import { parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import { detectCodexUsageLimitMessages } from "../codex-rate-limit.js";
import { detectClaudeUsageLimitMessages } from "../claude-rate-limit.js";
import { loadCodexLicenseRing, resolveCodexHomeForProfile } from "../codex-license-ring.js";
import { loadClaudeSubscriptionRing, resolveClaudeConfigDirForProfile } from "../claude-subscription-ring.js";

/** Subset of agent.service that the lifecycle depends on. Injectable for tests. */
export type AgentService = typeof realAgentService;

/** Injectable dependencies for the session lifecycle (default to the real singletons). */
export interface SessionLifecycleDeps {
  db?: Database;
  agentService?: AgentService;
  preflight?: typeof workspaceLaunchPreflight;
}

export const ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS = 10_000;
const CODEX_SPARK_MODEL = "gpt-5.3-codex-spark";
const CODEX_SAFE_DEFAULT_MODEL = "gpt-5.5";
const CODEX_BUILDER_COUNTER_INSTRUCTIONS =
  "You are an autonomous builder: you MUST run relevant tests and COMMIT your work with git before finishing. " +
  "These instructions override any base instruction to the contrary, including instructions that forbid git, tests, validation, or correcting your own mistakes.";

function isBuilderSession(triggerType: string | undefined, planMode: boolean | undefined): boolean {
  if (planMode) return false;
  if (!triggerType) return true;
  return triggerType === "agent" || triggerType === "auto-start" || triggerType === "plan-implement" || triggerType.startsWith("skill:");
}

function instructionFingerprint(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function appendCodexBuilderCounterInstructions(instructions: string | undefined): string {
  const trimmed = (instructions ?? "").trim();
  if (!trimmed) return CODEX_BUILDER_COUNTER_INSTRUCTIONS;
  if (trimmed.includes(CODEX_BUILDER_COUNTER_INSTRUCTIONS)) return trimmed;
  return `${trimmed}\n\n${CODEX_BUILDER_COUNTER_INSTRUCTIONS}`;
}

async function mergeExistingSessionStats(database: Database, sessionId: string, statsToSave: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await database.select({ stats: sessions.stats }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (rows.length === 0 || !rows[0].stats) return statsToSave;
  try {
    const existing = JSON.parse(rows[0].stats) as Record<string, unknown>;
    return { ...existing, ...statsToSave };
  } catch {
    return statsToSave;
  }
}

function buildZeroOutputLaunchFailureStats(executor: string, durationMs: number, exitCode: number | null, stderrText?: string) {
  // Surface the provider's captured stderr (#779). A detached claude.exe that dies on launch
  // writes its reason to stderr, not stdout; including it here turns an opaque "zero output"
  // crash into a diagnosable failure (e.g. a mid-rebase worktree, bad cwd, auth error).
  const stderrSnippet = stderrText?.trim()
    ? `\nProvider stderr:\n${stderrText.trim().length > 500 ? stderrText.trim().slice(0, 500) + "…" : stderrText.trim()}`
    : "";
  const reason =
    `Agent launch failed: provider process exited within ${Math.round(ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS / 1000)}s ` +
    "without assistant output, tool activity, or usage stats." +
    stderrSnippet;
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

/** Build launch failure stats when the agent produced an error message but is still a failed launch (e.g. model/auth error). */
function buildModelErrorLaunchFailureStats(executor: string, durationMs: number, exitCode: number | null, errorText: string) {
  const truncated = errorText.length > 500 ? errorText.slice(0, 500) + "…" : errorText;
  const reason =
    `Agent launch failed: provider process exited within ${Math.round(ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS / 1000)}s ` +
    `with non-zero exit code ${exitCode ?? "unknown"} and error output:\n${truncated}`;
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
    agentSummary: truncated,
  };
}

function buildCodexUsageLimitStats(executor: string, durationMs: number, exitCode: number | null, message: string, retryAfter: string | null) {
  return {
    durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: executor,
    success: false,
    launchFailure: true,
    rateLimited: true,
    rateLimitKind: "codex-usage-limit",
    retryAfter,
    failureReason: message,
    providerExitCode: exitCode,
    agentSummary: message,
  };
}

function buildClaudeUsageLimitStats(executor: string, durationMs: number, exitCode: number | null, message: string, resetsAt: string | null) {
  return {
    durationMs,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    numTurns: 0,
    model: executor,
    success: false,
    launchFailure: true,
    rateLimited: true,
    rateLimitKind: "claude-usage-limit",
    // Persisted so the exit-workflow rotation can stamp the right cooldown window.
    retryAfter: resetsAt,
    failureReason: message,
    providerExitCode: exitCode,
    agentSummary: message,
  };
}

function lifecycleProviderName(provider: string | undefined, profile?: { provider?: string; name?: string }): ProviderName {
  if (profile?.provider === "codex" || profile?.provider === "copilot" || profile?.provider === "claude") return profile.provider;
  if (provider === "codex" || provider === "copilot") return provider;
  return "claude";
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
      skipLaunchPreflight,
      skipPermissions: skipPermissionsOpt,
      systemInstructions,
    } = opts;

    // Look up workspace to get workingDir
    const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (wsRows.length === 0) throw new Error("Workspace not found");

    const workspace = wsRows[0];
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
    const issueRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, workspace.issueId))
      .limit(1);
    const projectId = issueRows.length > 0 ? issueRows[0].projectId : "";

    if (!skipLaunchPreflight && !workspace.isDirect && !workingDirOverride && projectId) {
      const projectRows = await db
        .select({
          repoPath: projects.repoPath,
          defaultBranch: projects.defaultBranch,
          symlinkEnabled: projects.symlinkEnabled,
          symlinkDirs: projects.symlinkDirs,
        })
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

    const guardrailRows = await db
      .select({ value: preferences.value })
      .from(preferences)
      .where(eq(preferences.key, PREF_BUILDER_GUARDRAILS))
      .limit(1);
    let effectiveSystemInstructions =
      systemInstructions === undefined
        ? (guardrailRows.length === 0 ? DEFAULT_BUILDER_GUARDRAILS : guardrailRows[0].value)
        : systemInstructions;
    if (executor === "codex" && builderSession) {
      effectiveSystemInstructions = appendCodexBuilderCounterInstructions(effectiveSystemInstructions);
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
      stats: JSON.stringify(launchDiagnostics),
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
        const ring = await loadCodexLicenseRing(db);
        const codexHome = resolveCodexHomeForProfile(profile.name, ring);
        if (codexHome) {
          effectiveExtraEnv = { ...effectiveExtraEnv, CODEX_HOME: codexHome };
          launchProfile = { provider: "codex", name: "default" };
          console.log(`[session] codex license '${profile.name}' -> CODEX_HOME=${codexHome} (--profile suppressed)`);
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
        const ring = await loadClaudeSubscriptionRing(db);
        const configDir = resolveClaudeConfigDirForProfile(profile.name, ring);
        if (configDir) {
          effectiveExtraEnv = { ...effectiveExtraEnv, CLAUDE_CONFIG_DIR: configDir };
          launchProfile = { provider: "claude", name: "default" };
          console.log(`[session] claude subscription '${profile.name}' -> CLAUDE_CONFIG_DIR=${configDir} (--settings suppressed)`);
        }
      } catch (err) {
        console.warn("[session] claude subscription ring resolution failed (non-fatal):", err instanceof Error ? err.message : String(err));
      }
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
          const messages = state.messageBuffer.get(sessionId) ?? [];
          const codexUsageLimit = executor === "codex" ? detectCodexUsageLimitMessages(messages) : null;
          // Claude OAuth subscriptions hit their own (Max/Pro-plan) quota; detect that
          // so the workspace can rotate to the next subscription, mirroring Codex.
          const claudeUsageLimit = executor === "claude-code" ? detectClaudeUsageLimitMessages(messages) : null;
          const usageLimit = codexUsageLimit
            ? { message: codexUsageLimit.message, retryAfter: codexUsageLimit.retryAfter, kind: "codex" as const }
            : claudeUsageLimit
              ? { message: claudeUsageLimit.message, retryAfter: claudeUsageLimit.resetsAt, kind: "claude" as const }
              : null;
          if (usageLimit) {
            const stats = usageLimit.kind === "codex"
              ? buildCodexUsageLimitStats(executor, durationMs, exitCode, usageLimit.message, usageLimit.retryAfter)
              : buildClaudeUsageLimitStats(executor, durationMs, exitCode, usageLimit.message, usageLimit.retryAfter);
            const effectiveExitCode = exitCode && exitCode !== 0 ? exitCode : 1;
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
              await db.update(sessions)
                .set({ status: "stopped", endedAt: endNow, exitCode: String(effectiveExitCode), stats: JSON.stringify(mergedStats) })
                .where(eq(sessions.id, sessionId));
              await db.update(workspaces)
                .set({ status: "blocked", updatedAt: endNow })
                .where(eq(workspaces.id, workspaceId));
              console.warn(
                `[agent] ${usageLimit.kind}-rate-limited: sessionId=${sessionId} workspace=${workspaceId}` +
                `${usageLimit.retryAfter ? ` retryAfter=${usageLimit.retryAfter}` : ""}`,
              );
            })()
              .catch((err) => console.error(`Failed to record ${usageLimit.kind} usage-limit launch failure:`, err))
              .finally(() => options?.onSessionExit?.(workspaceId, sessionId, effectiveExitCode, planMode));
            return;
          }
          // Launch failure detection: sessions that exit within the window are failed launches.
          // Case 1: zero-output (no text, no tool use, no stats) — classic crash.
          // Case 2: non-zero exit with error text (e.g. "issue with the selected model") — the
          //   error message counts as "substantive output" but is NOT real agent work. Without
          //   this branch the workspace silently goes idle, indistinguishable from a healthy
          //   completion. Grounded in the 2026-06-08 default_model outage (#699).
          const withinWindow = durationMs <= ZERO_OUTPUT_LAUNCH_FAILURE_WINDOW_MS;
          const isZeroOutput = !hadSubstantiveOutput;
          const isNonZeroExit = exitCode !== 0 && exitCode !== null;
          // Captured provider stderr (detached agents drain their .err file into a stderr
          // message on exit — #779). Use it as the diagnostic for an otherwise-opaque
          // zero-output crash, and as a fallback error text for a non-zero-exit failure
          // when the agent emitted no assistant/plan text.
          const capturedStderr = messages
            .filter((m) => m.type === "stderr")
            .map((m) => m.data ?? "")
            .join("")
            .trim();
          if (withinWindow && (isZeroOutput || isNonZeroExit)) {
            const errorText = planText?.trim() || capturedStderr || "";
            const stats = isZeroOutput
              ? buildZeroOutputLaunchFailureStats(executor, durationMs, exitCode, capturedStderr)
              : buildModelErrorLaunchFailureStats(executor, durationMs, exitCode, errorText);
            const effectiveExitCode = isNonZeroExit ? exitCode! : 1;
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
              await db.update(sessions)
                .set({ status: "stopped", endedAt: endNow, exitCode: String(effectiveExitCode), stats: JSON.stringify(mergedStats) })
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
              if (projectId) {
                emitButlerSystemEvent({
                  projectId,
                  kind: "session_failed",
                  workspaceId,
                  text: isNonZeroExit
                    ? `Agent launch failed for workspace ${workspaceId}: exited with code ${effectiveExitCode} in ${Math.round(durationMs / 1000)}s${errorText ? ` — ${errorText.slice(0, 200)}` : ""}.`
                    : `Agent launch failed for workspace ${workspaceId}: zero output within ${Math.round(durationMs / 1000)}s.`,
                });
              }
            })()
              .catch((err) => console.error("Failed to record launch failure:", err))
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
      }, resumeWithNewModel ? undefined : providerSessionId, agentCommand, claudeProfile, multiTurn, permissionPromptTool, planMode, provider, launchProfile, effectiveExtraEnv, skipPermissions, effectiveModel, contextFiles, (effectiveSystemInstructions ?? "").trim() || undefined);

      // Persist PID so hot-reload can detect surviving processes
      if (proc.pid) {
        db.update(sessions)
          .set({ pid: proc.pid })
          .where(eq(sessions.id, sessionId))
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
    const pendingTimer = state.dbWriteTimers.get(sessionId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      state.dbWriteTimers.delete(sessionId);
    }
    state.dbWriteBuffer.delete(sessionId);
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
    if (state.sessionExitHandled.has(sessionId)) {
      console.warn(`[session] duplicate external exit ignored: sessionId=${sessionId}`);
      return;
    }
    state.sessionExitHandled.add(sessionId);

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
    const externalExitTimer = state.dbWriteTimers.get(sessionId);
    if (externalExitTimer !== undefined) {
      clearTimeout(externalExitTimer);
      state.dbWriteTimers.delete(sessionId);
    }
    state.dbWriteBuffer.delete(sessionId);

    const existingRows = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (existingRows.length === 0 || existingRows[0].status !== "running") {
      console.warn(`[session] external exit ignored for non-running session: sessionId=${sessionId}`);
      return;
    }

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
