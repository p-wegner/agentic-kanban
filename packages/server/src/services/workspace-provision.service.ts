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
import { join } from "node:path";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { buildAgentPrompt } from "./workspace-create/policy.js";
import type { Database } from "../db/index.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import type { ProviderName } from "./agent-provider.js";
import { runSetupScript } from "./setup-script.js";
import type { SetupScriptContainer } from "@agentic-kanban/shared/lib/setup-script";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import { getPreference } from "../repositories/preferences.repository.js";
import { provisionContainerForWorkspace } from "./devcontainer-workspace.service.js";
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
import { writeAgentSkillFile, readLocalSkillPrompt, copySkillToWorktree } from "@agentic-kanban/shared/lib/agent-skill-files";
import { writeTicketContextFile } from "@agentic-kanban/shared/lib/ticket-context";
import { bootstrapSymlinks } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import { resolveWorkflowStart, buildTransitionBlock } from "@agentic-kanban/shared/lib/workflow-engine";
import { loadProjectRuntimeConfig } from "./project-runtime-config.service.js";
import { WorkspaceError, type CreateWorkspaceInput, type GitService } from "./workspace-internals.js";
import { buildContextPrimer } from "./context-packer.service.js";
import { getStackProfile } from "./stack-profile.service.js";

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
        console.warn(`[workspaces] symlink bootstrap error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const { setupScript, setupBlocking, setupEnabled } = setupConfig;
    let latestSetup = skippedSetupRun(setupScript);
    let setupCompletion: Promise<LatestSetupRun> | undefined;

    // Provision the devcontainer BEFORE the setup script (#135). A host-run
    // install produces node_modules that cannot resolve inside the container, so
    // when the builder is containerized the install has to happen in there.
    //
    // Provisioning here does not conflict with the launch-time call in
    // session-lifecycle: `devcontainer up` is idempotent, so the later call
    // simply re-derives the same handle. That keeps the two call sites
    // independent — no container state has to be threaded or persisted.
    let setupContainer: SetupScriptContainer | undefined;
    if (!isDirect && setupScript && setupEnabled && !input.skipSetup) {
      try {
        const provision = await provisionContainerForWorkspace({
          enabled: parseBoolSetting(
            "devcontainer_builders",
            await getPreference("devcontainer_builders", database),
          ),
          worktreePath,
          workspaceId,
          symlinkDirs: symlinkConfig.dirs,
        });
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
          console.warn(`[workspaces] setup error: ${err instanceof Error ? err.message : String(err)}`);
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
          console.warn(`[workspaces] parallel setup error: ${err instanceof Error ? err.message : String(err)}`);
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
      console.warn(`[workspaces] failed to install TDD hook: ${err instanceof Error ? err.message : String(err)}`);
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
      console.warn(`[workspaces] context-packer failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
    serviceStack?: { ports: Record<string, number>; envFilePath: string; composeProjectName: string; serviceHost: string } | null,
  ): Promise<string | null> {
    let stackProfile = null;
    try {
      stackProfile = await getStackProfile(issue.projectId, database);
    } catch (err) {
      console.warn(`[workspaces] stack-profile read failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    return writeTicketContextFile(worktreePath, {
      issueNumber: issue.issueNumber,
      title: issue.title,
      description: issue.description,
      contextPrimer,
      stackProfile,
      additionalRepos,
      serviceStack,
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
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null };
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

    // Fall back to the project-level default skill so Insights "By Skill" can
    // attribute sessions even when no explicit skill was chosen and the issue has
    // no workflow that provides one.
    if (!effectiveSkillId && !effectiveDiskSkill && project.defaultSkillId) {
      effectiveSkillId = project.defaultSkillId;
    }

    const skillName = worktreePath
      ? await resolveSkillFile(effectiveSkillId, effectiveDiskSkill, worktreePath, project.repoPath)
      : null;

    return { agentPrompt, skillName, effectiveSkillId, hasWorkflowStart: Boolean(workflowStart) };
  }


  return {
    setupWorktree,
    buildAgentConfig,
    installTddHook,
    packContextPrimer,
    writeWorktreeTicketContext,
    resolveAgentPromptAndSkill,
  };
}
