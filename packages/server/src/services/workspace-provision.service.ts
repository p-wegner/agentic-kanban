/**
 * Workspace provisioning — preparing a workspace for launch, extracted from
 * workspace-create.service.ts. Owns the side-effecting worktree setup (git
 * worktree + dependency symlink bootstrap + setup script), the agent config /
 * provider-profile resolution, the prompt + skill materialization, the TDD git
 * hook, the context-packer primer, and the CLAUDE.local.md ticket context.
 *
 * The create service instantiates this factory (sharing database + gitService)
 * and calls these steps from createWorkspace / computeLaunchPreview. Every step is
 * deterministic given its inputs + the on-disk repo; best-effort steps never throw.
 */

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, basename } from "node:path";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { buildAgentPrompt } from "./workspace-create/policy.js";
import type { Database } from "../db/index.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import { listPluginRows, isPluginEnabledForProject } from "../repositories/plugins.repository.js";
import { parsePluginManifest, parsePluginLoopUnitKey, pluginSkillName } from "@agentic-kanban/shared/lib/plugin-manifest";
import { parseOnboardingUnitKey, parseInitSkillStepId } from "@agentic-kanban/shared/lib/onboarding-plan";
import type { ProviderName } from "./agent-provider.js";
import { runSetupScript } from "./setup-script.js";
import type { SetupScriptContainer } from "@agentic-kanban/shared/lib/setup-script";
import { getPreference } from "../repositories/preferences.repository.js";
import { provisionContainerForWorkspace, resolveDevcontainerProvisionOptions } from "./devcontainer-workspace.service.js";
import {
  buildSetupRunFromResult,
  buildSetupRunFromError,
  skippedSetupRun,
  disabledSymlinkRun,
  buildSymlinkRun,
  buildSymlinkErrorRun,
  type LatestSetupRun,
  type LatestSymlinkRun,
} from "./workspace-run-records.js";
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree, listLocalSkillNames } from "@agentic-kanban/shared/lib/agent-skill-files";
import { buildSkillInvocationBlock, selectBuilderSkills } from "@agentic-kanban/shared/lib/builder-skill-policy";
import { writeTicketContextFile } from "@agentic-kanban/shared/lib/ticket-context";
import { bootstrapSymlinks } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import { resolveWorkflowStart, buildTransitionBlock } from "@agentic-kanban/shared/lib/workflow-engine";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import { WorkspaceError, type CreateWorkspaceInput, type GitService } from "./workspace-internals.js";
import { buildContextPrimer } from "./context-packer.service.js";
import { getStackProfile, resolveEffectiveVerify } from "./stack-profile.service.js";
import { resolveBoardFeedbackRouting } from "./board-feedback-routing.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export function createWorkspaceProvisionService(deps: {
  database: Database;
  gitService: GitService;
}) {
  const { database, gitService } = deps;

  async function setupWorktree(
    isDirect: boolean,
    repoPath: string,
    defaultBranch: string | null,
    input: Pick<CreateWorkspaceInput, "branch" | "baseBranch" | "skipSetup">,
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean },
    symlinkConfig: { enabled: boolean; dirs: string[] },
    workspaceId: string,
    // The profile this workspace's agent will actually launch under (#155). Passed
    // in from buildAgentConfig, resolved BEFORE this call, so the setup-path
    // devcontainer provision below mounts the SAME profile the launch-time call in
    // session-lifecycle.ts will use — not the default profile it used to fall back to.
    agentProfile: { claudeProfile?: string; settingsProfile?: string },
    issue?: { issueNumber?: number | null; title: string },
  ): Promise<{
    branch: string;
    worktreePath: string;
    baseBranch: string | null;
    baseCommitSha: string | null;
    latestSetup: LatestSetupRun;
    setupCompletion?: Promise<LatestSetupRun>;
    symlinkRun: LatestSymlinkRun;
  }> {
    let branch: string;
    let worktreePath: string;
    let baseBranch: string | null;
    let baseCommitSha: string | null;
    let symlinkRun = disabledSymlinkRun();

    if (isDirect) {
      branch = await gitService.getCurrentBranch(repoPath);
      worktreePath = repoPath;
      baseBranch = null;
      baseCommitSha = await gitService.getHeadCommitSha(repoPath);
    } else {
      baseBranch = input.baseBranch || defaultBranch;
      if (!baseBranch) {
        throw new WorkspaceError(
          "No default branch configured for this project. Set a default branch in project settings or choose a base branch.",
          "BAD_REQUEST",
        );
      }
      branch = input.branch || (issue ? suggestBranchName(issue) : "");
      baseCommitSha = await gitService.revParse(repoPath, baseBranch);
      worktreePath = await gitService.createWorktree(repoPath, branch, baseBranch);
    }

    // Symlink dependency directories from the main checkout into the worktree.
    // Best-effort: never blocks workspace creation on failure.
    if (!isDirect && symlinkConfig.enabled && symlinkConfig.dirs.length > 0) {
      const symlinkStartedAt = new Date().toISOString();
      try {
        const symlinkResult = await bootstrapSymlinks(repoPath, worktreePath, symlinkConfig.dirs);
        symlinkRun = buildSymlinkRun(symlinkConfig.dirs, symlinkStartedAt, symlinkResult);
        if (symlinkResult.linked.length > 0) {
          console.log(`[workspaces] symlink bootstrap: linked [${symlinkResult.linked.join(", ")}] for workspaceId=${workspaceId}`);
        }
        if (symlinkResult.failed.length > 0) {
          console.warn(`[workspaces] symlink bootstrap: failed [${symlinkResult.failed.map(f => `${f.dir}: ${f.error}`).join(", ")}] for workspaceId=${workspaceId}`);
        }
      } catch (err) {
        symlinkRun = buildSymlinkErrorRun(symlinkConfig.dirs, symlinkStartedAt, err);
        console.warn(`[workspaces] symlink bootstrap error (non-fatal): ${errorMessage(err)}`);
      }
    }

    const { setupScript, setupBlocking, setupEnabled } = setupConfig;
    let latestSetup = skippedSetupRun(setupScript);
    let setupCompletion: Promise<LatestSetupRun> | undefined;

    // Provision the devcontainer BEFORE the setup script (#135). A host-run
    // install produces node_modules that cannot resolve inside the container, so
    // when the builder is containerized the install has to happen in there.
    //
    // `devcontainer up` reuses an existing container and its CREATION-TIME mounts
    // win — it is idempotent about bringing a container up, NOT about which
    // profile is mounted into it. So this call MUST pass the same resolved
    // `agentProfile` the launch-time call in session-lifecycle.ts will use (#155);
    // passing none here used to freeze the container on the DEFAULT profile mount
    // regardless of what the agent actually launches under. devcontainer-workspace
    // service also detects and recreates a container whose existing mount
    // disagrees with the profile requested here, as a second line of defense.
    let setupContainer: SetupScriptContainer | undefined;
    if (!isDirect && setupScript && setupEnabled && !input.skipSetup) {
      try {
        const provisionOptions = await resolveDevcontainerProvisionOptions({
          worktreePath,
          workspaceId,
          readPreference: (key) => getPreference(key, database),
          // #577: gate on `enabled`, exactly as the launch-time builder does. Line 105
          // above already refuses to bootstrap symlinks when the feature is off — passing
          // the dirs here anyway mounted dependency volumes the project had switched OFF,
          // and because `devcontainer up` reuses an existing container whose CREATION-TIME
          // mounts win, that mismatch then outlived the launch-time request that got it right.
          resolveSymlink: async () => symlinkConfig,
          // #577: `strict` was not read here at all, so a strict project's SETUP silently
          // ran on the host — the precise thing #135 moved into the container to avoid.
          // It now comes from the shared resolver, so it cannot go missing again.
          profile: {
            claudeProfile: agentProfile.claudeProfile,
            settingsProfile: agentProfile.settingsProfile,
          },
        });
        const { provision } = provisionOptions
          ? await provisionContainerForWorkspace(provisionOptions)
          : { provision: undefined };
        setupContainer = provision?.handle;
      } catch (err) {
        console.warn(
          `[devcontainer] provisioning threw before setup for workspaceId=${workspaceId} — running setup on the host`,
          err,
        );
      }
    }

    if (!isDirect && setupScript && setupEnabled && !input.skipSetup) {
      const startedAt = new Date().toISOString();
      if (setupContainer) {
        console.log(
          `[workspaces] setup runs in container ${setupContainer.containerId.slice(0, 12)} for workspaceId=${workspaceId}`,
        );
      }
      if (setupBlocking) {
        try {
          const result = await runSetupScript(worktreePath, setupScript, { container: setupContainer });
          latestSetup = buildSetupRunFromResult(setupScript, startedAt, result);
          if (result.exitCode === 0) {
            console.log(`[workspaces] setup complete: workspaceId=${workspaceId}`);
          } else {
            console.warn(`[workspaces] setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
          }
        } catch (err) {
          latestSetup = buildSetupRunFromError(setupScript, startedAt, err);
          console.warn(`[workspaces] setup error: ${errorMessage(err)}`);
        }
      } else {
        latestSetup = {
          command: setupScript,
          state: "running",
          startedAt,
          endedAt: null,
          exitCode: null,
          durationMs: null,
          stdoutTail: null,
          stderrTail: null,
        };
        setupCompletion = runSetupScript(worktreePath, setupScript, { container: setupContainer }).then(result => {
          if (result.exitCode === 0) {
            console.log(`[workspaces] parallel setup complete: workspaceId=${workspaceId}`);
          } else {
            console.warn(`[workspaces] parallel setup failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
          }
          return buildSetupRunFromResult(setupScript, startedAt, result);
        }).catch(err => {
          console.warn(`[workspaces] parallel setup error: ${errorMessage(err)}`);
          return buildSetupRunFromError(setupScript, startedAt, err);
        });
      }
    }

    return { branch, worktreePath, baseBranch, baseCommitSha, latestSetup, setupCompletion, symlinkRun };
  }

  // buildAgentPrompt / neutralizeBuildTimeVisualVerification /
  // isBuildTimeVisualVerificationInstruction are pure policy — extracted to
  // ./workspace-create/policy.ts and unit-tested there. Imported at top of file.

  async function resolveSkillFile(
    skillId: string | null,
    diskSkillName: string | null,
    worktreePath: string,
    repoPath: string,
  ): Promise<string | null> {
    if (skillId) {
      const skillRows = await crudRepo.getAgentSkillById(skillId, database);
      if (skillRows.length === 0) return null;
      const skill = skillRows[0];
      const localPrompt = await readLocalSkillPrompt(repoPath, skill.name);
      const effectiveSkill = localPrompt ? { ...skill, prompt: localPrompt } : skill;
      await writeAgentSkillFile(worktreePath, effectiveSkill);
      return skill.name;
    }
    if (diskSkillName) {
      const copied = await copySkillToWorktree(repoPath, diskSkillName, worktreePath);
      return copied ? diskSkillName : null;
    }
    return null;
  }

  /**
   * Copy every skill declared by a plugin ENABLED for this project into the
   * worktree — not just the one skill `resolveSkillFile` resolves for the
   * workspace's own skill/workflow selection.
   *
   * `enableForProject` only fans a plugin's skills out into the project's
   * LEADING repo (`fanOutSkills`, junctioned + excluded via `.git/info/exclude`
   * so it never lands in git). A worktree is a separate checkout that never
   * sees a gitignored path, so a plugin-loop ticket (or any other ticket for a
   * project with a safety-net-style plugin enabled) launched with only
   * `board-navigator` present — the agent could read the skill's NAME in the
   * ticket prose but had no bundle to actually run (#204). `copySkillToWorktree`
   * already handles dereferencing the junction into real files, so this reuses
   * it per enabled plugin's skill list instead of materializing only one.
   *
   * Best-effort: a broken plugin manifest or a missing skill source must not
   * block workspace creation.
   */
  async function materializeEnabledPluginSkills(worktreePath: string, repoPath: string, projectId: string): Promise<void> {
    try {
      const rows = await listPluginRows(database);
      for (const row of rows) {
        if (!(await isPluginEnabledForProject(row.pluginId, projectId, database))) continue;
        let manifest;
        try {
          manifest = parsePluginManifest(row.manifestJson);
        } catch {
          continue;
        }
        for (const skill of manifest.skills ?? []) {
          const name = basename(skill.dir.replace(/\\/g, "/"));
          await copySkillToWorktree(repoPath, name, worktreePath);
        }
      }
    } catch (err) {
      console.warn(`[workspaces] plugin-skill materialization failed (non-fatal): ${errorMessage(err)}`);
    }
  }

  /**
   * The skill a plugin-loop unit ticket must launch with (#321).
   *
   * A loop ticket is created by `advanceLoop` with no skill selection, and every start path
   * (`startPlannedLoopTickets`, the monitor's auto-start pass, a manual launch) calls
   * `createWorkspace` without one — so `resolveAgentPromptAndSkill` fell through to the project
   * DEFAULT skill. Measured on workspace fc679902 (issue #12, `plugin-loop:pm-pipeline:pipeline:
   * step-9:v2`): `skillId` = board-navigator and the session's `trigger_type` =
   * `skill:board-navigator`, while the loop declares `skill: "pm-step-runner"`. The wrong skill was
   * PERSISTED, not merely mislabeled — the ticket prose named the right skill and the launch
   * announced a different one.
   *
   * Returns the loop's `skill` from the plugin manifest, or null when this is not a loop ticket /
   * the plugin is no longer enabled here. The enabled check matters: only an ENABLED plugin's
   * skills are materialized into the worktree (`materializeEnabledPluginSkills`), so naming a
   * disabled plugin's skill would resolve to a file that isn't there.
   */
  async function resolvePluginLoopSkillName(
    externalKey: string | null | undefined,
    projectId: string,
  ): Promise<string | null> {
    const unit = parsePluginLoopUnitKey(externalKey);
    if (!unit) return null;
    try {
      const row = (await listPluginRows(database)).find((r) => r.pluginId === unit.pluginSlug);
      if (!row) return null;
      if (!(await isPluginEnabledForProject(row.pluginId, projectId, database))) return null;
      const loop = (parsePluginManifest(row.manifestJson).loops ?? []).find((l) => l.name === unit.loopName);
      return loop?.skill ?? null;
    } catch (err) {
      // Best-effort, exactly like the materialization above: a broken manifest must not fail a
      // launch. The old project-default fallback still applies.
      console.warn(`[workspaces] plugin-loop skill resolution failed (non-fatal): ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * The skill an onboarding init-skill ticket must launch with (#474).
   *
   * Mirrors {@link resolvePluginLoopSkillName}: `applyOnboardingStep` files a ticket whose whole
   * body names the skill in prose, with no `skillId` passed to `createWorkspace`, so launch fell
   * through to the project default and the init skill's prompt was never loaded. The ticket's
   * `external_key` (`onboarding:<projectId>:<stepId>`) already embeds which skill — a DB row
   * (builtin/user-created `isInit` skill) or a plugin's manifest-declared entry skill — via
   * `parseInitSkillStepId`, so no schema change is needed.
   *
   * Returns a DB `skillId`, a disk `diskSkillName`, or both null when this is not an onboarding
   * init-skill ticket / the referenced skill no longer exists / its plugin is no longer enabled
   * here (mirrors the loop resolver: a disabled plugin's skill is never materialized into the
   * worktree, so naming it would point the agent at a file that isn't there).
   */
  async function resolveOnboardingInitSkillName(
    externalKey: string | null | undefined,
    projectId: string,
  ): Promise<{ skillId: string | null; diskSkillName: string | null }> {
    const none = { skillId: null, diskSkillName: null };
    const unit = parseOnboardingUnitKey(externalKey);
    if (!unit || unit.projectId !== projectId) return none;
    const parsed = parseInitSkillStepId(unit.stepId);
    if (!parsed) return none;
    if (parsed.source === "db") {
      try {
        const rows = await crudRepo.getAgentSkillById(parsed.skillId, database);
        return rows.length > 0 ? { skillId: parsed.skillId, diskSkillName: null } : none;
      } catch (err) {
        console.warn(`[workspaces] onboarding init-skill resolution failed (non-fatal): ${errorMessage(err)}`);
        return none;
      }
    }
    try {
      const row = (await listPluginRows(database)).find((r) => r.pluginId === parsed.pluginSlug);
      if (!row) return none;
      if (!(await isPluginEnabledForProject(row.pluginId, projectId, database))) return none;
      const stillDeclared = (parsePluginManifest(row.manifestJson).skills ?? [])
        .some((s) => pluginSkillName(s.dir) === parsed.skillName);
      return stillDeclared ? { skillId: null, diskSkillName: parsed.skillName } : none;
    } catch (err) {
      // Best-effort, exactly like the loop resolution above: a broken manifest must not fail a
      // launch. The old project-default fallback still applies.
      console.warn(`[workspaces] onboarding init-skill resolution failed (non-fatal): ${errorMessage(err)}`);
      return none;
    }
  }

  async function buildAgentConfig(
    input: Pick<CreateWorkspaceInput, "profile" | "claudeProfile" | "model">,
    projectId?: string,
  ): Promise<{
    agentCommand: string | undefined;
    agentArgs: string | undefined;
    claudeProfile: string | undefined;
    resolvedProfile: string | undefined;
    resolvedProvider: ProviderName;
    resolvedProfileSelection: { provider: ProviderName; name: string } | undefined;
    permissionPromptTool: string | undefined;
    model: string | undefined;
    systemInstructions: string;
    /**
     * Non-null when the project's profile allowlist permits no launch right now. The
     * other fields still carry the unrestricted resolution, so a caller that LAUNCHES
     * must refuse on this; a caller that merely PREVIEWS may report it and continue.
     */
    profileHold: string | null;
    /**
     * True when the project's profile allowlist overrode the caller's choice. The create
     * path logs the resolver's note; a PREVIEW has to turn this into a visible warning,
     * or the dialog shows the profile the user picked while the launch silently uses
     * another one.
     */
    profileClamped: boolean;
  }> {
    const runtime = await loadProjectRuntimeConfig(database, {
      projectId: projectId ?? "",
      profileOverride: input.profile,
      legacyProfileOverride: input.claudeProfile,
      // Precedence: an explicit per-workspace model wins; otherwise honor the strategy policy's
      // pinned model (#818) so a project can run e.g. claude/sonnet without the global
      // default_model footgun. resolveProviderConfig still falls back to default_model when both
      // are unset, and drops a model that doesn't belong to the resolved provider.
      requestedModel: input.model,
    });
    for (const note of runtime.provider.notes) {
      console.log(`[workspaces] ${note}`);
    }

    return {
      agentCommand: runtime.provider.agentCommand,
      agentArgs: runtime.provider.agentArgs,
      claudeProfile: runtime.provider.profileName,
      resolvedProfile: runtime.provider.profileName,
      resolvedProvider: runtime.provider.provider,
      resolvedProfileSelection: runtime.provider.profileSelection,
      permissionPromptTool: runtime.provider.permissionPromptTool,
      model: runtime.provider.model,
      systemInstructions: runtime.systemInstructions,
      profileHold: runtime.provider.profileHold,
      profileClamped: runtime.provider.profileClamped,
    };
  }

  function installTddHook(worktreePath: string): void {
    try {
      const hooksDir = join(worktreePath, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "commit-msg");
      const hookScript = `#!/bin/sh
# TDD mode: ensure AC test commit comes before implementation commits.
MSG=$(cat "$1")
# If this commit is the AC test commit, allow it.
if echo "$MSG" | grep -qE '^test: AC for #[0-9]+'; then
  exit 0
fi
# Check if an AC test commit already exists on this branch.
if git log --oneline | grep -qE ' test: AC for #[0-9]+'; then
  exit 0
fi
echo "TDD mode: write failing AC tests first." >&2
echo "  Commit your tests with: git commit -m 'test: AC for #<issue-number>'" >&2
exit 1
`;
      writeFileSync(hookPath, hookScript, { encoding: "utf-8" });
      try {
        chmodSync(hookPath, 0o755);
      } catch {
        // chmod may fail on Windows; hook still runs via Git for Windows bash
      }
      console.log(`[workspaces] TDD commit-msg hook installed: ${hookPath}`);
    } catch (err) {
      console.warn(`[workspaces] failed to install TDD hook: ${errorMessage(err)}`);
    }
  }

  /**
   * Best-effort context-packer run. Returns the primer text, or null when packing
   * is empty or fails — packing must never block workspace creation.
   */
  async function packContextPrimer(
    input: CreateWorkspaceInput,
    issue: { title: string; description: string | null; projectId: string },
    project: { repoPath: string },
  ): Promise<string | null> {
    try {
      const packed = await buildContextPrimer(
        {
          issueId: input.issueId,
          issueTitle: issue.title,
          issueDescription: issue.description,
          projectId: issue.projectId,
          repoPath: project.repoPath,
        },
        database,
      );
      if (packed.primer.trim()) return packed.primer;
    } catch (err) {
      console.warn(`[workspaces] context-packer failed (non-fatal): ${errorMessage(err)}`);
    }
    return null;
  }

  /**
   * Inject ticket details (+ optional context primer + detected stack profile) into
   * the worktree as a gitignored CLAUDE.local.md so the agent's first turn has the
   * spec without foraging. Returns the file path. The stack-profile read is
   * best-effort — a failure there must not block creation.
   */
  async function writeWorktreeTicketContext(
    worktreePath: string,
    issue: { issueNumber: number | null; title: string; description: string | null; projectId: string },
    contextPrimer: string | null,
    additionalRepos?: Array<{ name: string | null; worktreePath: string }>,
    serviceStack?: {
      ports: Record<string, number>;
      envFilePath: string;
      composeProjectName: string;
      serviceHost: string;
      lintWarnings?: string[] | null;
    } | null,
    // Ticket group (#661): the member tickets rendered in full below the lead one.
    groupTickets?: Array<{ issueNumber: number | null; title: string; description: string | null }> | null,
  ): Promise<string | null> {
    let stackProfile = null;
    try {
      stackProfile = await getStackProfile(issue.projectId, database);
    } catch (err) {
      console.warn(`[workspaces] stack-profile read failed (non-fatal): ${errorMessage(err)}`);
    }
    // #551: ask the ONE resolver the gate itself asks — override first, then the stack
    // derivation, then the marker-rule fallback. Reading only the profile here (as this did
    // before #575) or only the pref (as it did after) both leave cases where the ticket's
    // "this is the exact command the board runs" promise is false.
    let verifyCommandOverride: string | null = null;
    try {
      const effective = await resolveEffectiveVerify(issue.projectId, database, { profile: stackProfile });
      verifyCommandOverride = effective?.command ?? null;
    } catch (err) {
      console.warn(`[workspaces] verify command resolve failed (non-fatal): ${errorMessage(err)}`);
    }
    // Best-effort like the stack profile: a builder still gets its ticket even if we
    // can't tell it where to route board feedback.
    let boardFeedback = null;
    try {
      boardFeedback = await resolveBoardFeedbackRouting(issue.projectId, database);
    } catch (err) {
      console.warn(`[workspaces] board-feedback routing failed (non-fatal): ${errorMessage(err)}`);
    }
    return writeTicketContextFile(worktreePath, {
      issueNumber: issue.issueNumber,
      title: issue.title,
      description: issue.description,
      contextPrimer,
      stackProfile,
      verifyCommandOverride,
      additionalRepos,
      serviceStack,
      boardFeedback,
      groupTickets,
    });
  }

  /**
   * Build the agent prompt and resolve the effective skill. Merges the base prompt
   * with the issue's configurable workflow (start-node guidance + transitions) and
   * resolves the skill from explicit input → workflow node → project default,
   * materializing the chosen skill file into the worktree. Returns the prompt, the
   * resolved skill name (for session attribution), and the effective skill id (for
   * the workspace row).
   */
  async function resolveAgentPromptAndSkill(params: {
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null; externalKey?: string | null };
    input: CreateWorkspaceInput;
    includeVisualProof: boolean;
    workspaceId: string;
    worktreePath: string | null;
    project: { repoPath: string; defaultSkillId: string | null };
    skillId: string | null;
  }): Promise<{ agentPrompt: string; skillName: string | null; effectiveSkillId: string | null; hasWorkflowStart: boolean }> {
    const { issue, input, includeVisualProof, workspaceId, worktreePath, project, skillId } = params;
    let agentPrompt = buildAgentPrompt(issue, { ...input, includeVisualProof }, input.issueId);

    // Resolve the issue's configurable workflow (if any). The start node's
    // guidance + valid transitions are injected into the prompt, and its
    // attached skill is used when the caller didn't pick one explicitly.
    const workflowStart = await resolveWorkflowStart(database, input.issueId);
    let effectiveSkillId = skillId;
    let effectiveDiskSkill = input.skillName ?? null;
    if (workflowStart) {
      agentPrompt += `\n\n${buildTransitionBlock(workflowStart.node, workflowStart.transitions, workspaceId)}`;
      if (!effectiveSkillId && !effectiveDiskSkill) {
        effectiveSkillId = workflowStart.node.skillId ?? null;
        effectiveDiskSkill = workflowStart.node.skillName ?? null;
      }
    }

    // A plugin-loop unit ticket carries its LOOP's skill (#321) — ahead of the project default,
    // behind an explicit choice and a workflow node, both of which are deliberate selections.
    if (!effectiveSkillId && !effectiveDiskSkill) {
      effectiveDiskSkill = await resolvePluginLoopSkillName(issue.externalKey, issue.projectId);
    }

    // An onboarding init-skill ticket carries its skill in the external key too (#474) — same
    // precedence as the plugin-loop resolution above.
    if (!effectiveSkillId && !effectiveDiskSkill) {
      const onboarding = await resolveOnboardingInitSkillName(issue.externalKey, issue.projectId);
      effectiveSkillId = onboarding.skillId;
      effectiveDiskSkill = onboarding.diskSkillName;
    }

    // Fall back to the project-level default skill so Insights "By Skill" can
    // attribute sessions even when no explicit skill was chosen and the issue has
    // no workflow that provides one.
    if (!effectiveSkillId && !effectiveDiskSkill && project.defaultSkillId) {
      effectiveSkillId = project.defaultSkillId;
    }

    const skillName = worktreePath
      ? await resolveSkillFile(effectiveSkillId, effectiveDiskSkill, worktreePath, project.repoPath)
      : null;

    // Every skill an ENABLED plugin declares (not just the one resolved above) —
    // a plugin-loop ticket's skill, and any other safety-net skill a plugin
    // offers, must be readable in this worktree regardless of which agent
    // provider/machine launches it (#204).
    if (worktreePath) {
      await materializeEnabledPluginSkills(worktreePath, project.repoPath, issue.projectId);
    }

    // #129: a skill nobody invokes is a per-turn context tax for nothing — over
    // 200 builder sessions, 0/47 materialized skills were ever fired. Name the
    // ones this worktree actually has so the agent knows to reach for them.
    // Scoped to the builder-relevant set + the resolved skill; the repo may have
    // dozens of committed skills and listing them all would BE the tax.
    if (worktreePath) {
      const present = await listLocalSkillNames(worktreePath);
      const announced = selectBuilderSkills(present);
      if (skillName && present.includes(skillName) && !announced.includes(skillName)) {
        announced.unshift(skillName);
      }
      const block = buildSkillInvocationBlock(announced);
      if (block) agentPrompt += `\n\n${block}`;
    }

    return { agentPrompt, skillName, effectiveSkillId, hasWorkflowStart: Boolean(workflowStart) };
  }


  return {
    setupWorktree,
    buildAgentConfig,
    installTddHook,
    packContextPrimer,
    materializeEnabledPluginSkills,
    writeWorktreeTicketContext,
    resolveAgentPromptAndSkill,
  };
}
