/**
 * The read-only dry-run of the workspace-create pipeline: what WOULD happen on launch,
 * computed without a worktree, a DB row, or an agent.
 *
 * Split out of workspace-create.service.ts, which had grown past the 1000-line god-module
 * ceiling. The seam is the natural one: the create path is the side-effecting orchestration,
 * this is the pure projection of the same decisions, and the only things it needed from that
 * closure were four collaborators — now an explicit `LaunchPreviewDeps`. Keeping them
 * INJECTED rather than re-imported is the point: the preview must answer with the same
 * `buildAgentConfig` / `resolveIssueAndProject` the launch actually runs, because a preview
 * that re-derives its own answer is a preview that can lie about the launch.
 */

import { basename } from "node:path";
import { suggestBranchName } from "@agentic-kanban/shared/lib/branch";
import { isResolvedDependencyStatusView } from "@agentic-kanban/shared/lib/status-view";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { derivePortsFromBranch } from "./worktree-ports.js";
import { preflightAgentProfile } from "./agent-profile-health.service.js";
import { resolveScopedSiblingRepos, resolveEffectiveRepoScope } from "./workspace-repos.service.js";
import { getIssueReposTouched } from "./repo-tags.service.js";
import { estimateBudget, type BudgetEstimate } from "./budget-estimator.service.js";
import { listProjectRepos } from "../repositories/repo.repository.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import type { Database } from "../db/index.js";
import type { CreateWorkspaceInput, GitService } from "./workspace-internals.js";
import type { createWorkspaceProvisionService } from "./workspace-provision.service.js";

type ProvisionService = ReturnType<typeof createWorkspaceProvisionService>;

/** What the preview needs from the create service — see the module note on why these are injected. */
export interface LaunchPreviewDeps {
  database: Database;
  gitService: GitService;
  /** The SAME lookup the create path uses, so the preview cannot resolve a different issue/project. */
  resolveIssueAndProject: (issueId: string) => Promise<{
    issue: { projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null };
    project: { repoPath: string; defaultBranch: string | null; defaultSkillId: string | null; servicesConfig: string | null };
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean };
  }>;
  /** The SAME provider/profile/model resolution the launch runs — allowlist clamps and holds included. */
  buildAgentConfig: ProvisionService["buildAgentConfig"];
}

export interface LaunchPreview {
  branch: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  tddMode: boolean;
  requiresReview: boolean;
  setupScript: { enabled: boolean; command: string | null; blocking: boolean; willRun: boolean } | null;
  skill: { id: string; name: string } | null;
  provider: string;
  profile: string | null;
  model: string | null;
  warnings: string[];
  budgetEstimate: BudgetEstimate;
  ports: { serverPort: number; clientPort: number } | null;
  blockedBy: { issueNumber: number; title: string }[];
  multiRepo: {
    leadingRepoName: string;
    worktrees: { id: string; name: string; leading: boolean; selected: boolean; hasServiceStack: boolean }[];
  } | null;
}

export function createLaunchPreviewService(deps: LaunchPreviewDeps) {
  const { database, gitService, resolveIssueAndProject, buildAgentConfig } = deps;

  /** Read-only dry-run: compute what would happen on launch without side effects. */
  async function computeLaunchPreview(input: CreateWorkspaceInput): Promise<LaunchPreview> {
      const isDirect = input.isDirect === true;
      const warnings: string[] = [];

      // 1. Resolve issue + project (same lookup as createWorkspace)
      const { issue, project, setupConfig } = await resolveIssueAndProject(input.issueId);

      // 2. Resolve plan mode default (high/critical → plan mode on)
      const isHighPriority = issue.priority === "high" || issue.priority === "critical";
      const planMode = input.planMode !== undefined ? input.planMode === true : isHighPriority;
      const tddMode = input.tddMode === true;
      const requiresReview = input.requiresReview === true;

      // 3. Branch / base-branch resolution (no worktree creation)
      let branch: string | null;
      let baseBranch: string | null;
      if (isDirect) {
        try {
          branch = await gitService.getCurrentBranch(project.repoPath);
        } catch {
          branch = "(unknown)";
        }
        baseBranch = null;
      } else {
        branch = input.branch || suggestBranchName(issue);
        baseBranch = input.baseBranch || project.defaultBranch || null;
        if (!baseBranch) {
          warnings.push("No base branch configured — workspace creation will fail. Set a project default branch or choose a base branch.");
        }
      }

      // 4. Agent config resolution (provider, profile, model) — reuses same logic
      const agentConfig = await buildAgentConfig(input, issue.projectId);
      // Preview, so these report rather than throw — but they must be shown, or the dialog
      // offers a launch the create path will refuse (hold), or shows the profile the user
      // picked while the launch quietly uses a different one (clamp).
      if (agentConfig.profileHold) {
        warnings.push(`Profile allowlist blocks this launch: ${agentConfig.profileHold}.`);
      } else if (agentConfig.profileClamped) {
        const asked = input.profile?.name || input.claudeProfile;
        warnings.push(
          asked
            ? `Profile allowlist: ${asked} is not available for this project — launching on ${agentConfig.resolvedProfile}.`
            : `Profile allowlist: launching on ${agentConfig.resolvedProfile}.`,
        );
      }

      // 5. Skill resolution (name only, no file writes)
      const skillId = input.skillId || null;
      let skill: { id: string; name: string } | null = null;
      if (skillId) {
        const skillRows = await crudRepo.getAgentSkillNameById(skillId, database);
        if (skillRows.length > 0) skill = skillRows[0];
      }

      // 6. Setup script info (computed, not run)
      const setupScript = setupConfig.setupScript
        ? {
            enabled: setupConfig.setupEnabled,
            command: setupConfig.setupScript,
            blocking: setupConfig.setupBlocking,
            willRun: setupConfig.setupEnabled && !input.skipSetup,
          }
        : null;

      // 7. Conflict detection: existing active/idle workspaces on this issue
      const existingWs = await crudRepo.findExistingWorkspacesForIssue(input.issueId, database);
      const activeExisting = existingWs.filter(ws => ws.status === "active" || ws.status === "idle" || ws.status === "fixing");
      if (activeExisting.length > 0) {
        const labels = activeExisting.map(ws =>
          `${ws.branch || "direct"} (${ws.status})`
        );
        warnings.push(
          `Issue already has ${activeExisting.length} active workspace(s): ${labels.join(", ")}. Multiple concurrent workspaces on the same issue may cause merge conflicts.`,
        );
      }

      // 8. Branch name collision check (for non-direct workspaces)
      if (!isDirect && branch) {
        const branchExists = existingWs.some(ws => ws.branch === branch);
        if (branchExists) {
          warnings.push(`Branch "${branch}" already has a workspace. This will create a new worktree on the same branch.`);
        }
      }

      // 9. Missing base branch warning
      if (isDirect && !project.defaultBranch) {
        warnings.push("Project has no default branch configured. Some features (merge, diff) may not work.");
      }

      // 10. Profile availability check
      if (agentConfig.resolvedProfileSelection) {
        const { provider, name } = agentConfig.resolvedProfileSelection;
        const prefRows = await crudRepo.getAllPreferences(database);
        const prefMap = toPrefMap(prefRows);
        const profileCheck = preflightAgentProfile(prefMap, provider, name);
        if (!profileCheck.ok) {
          for (const err of profileCheck.errors) {
            warnings.push(`Profile unavailable: ${err}`);
          }
        }
      }

      // 11. Dependency blocking check
      const BLOCKING_DEP_TYPES = ["depends_on", "blocked_by"] as const;
      const depRows = await crudRepo.getDependenciesForIssue(input.issueId, database);

      const blockerIds = depRows
        .filter(d => BLOCKING_DEP_TYPES.includes(d.type as typeof BLOCKING_DEP_TYPES[number]))
        .map(d => d.dependsOnId);

      let blockedBy: { issueNumber: number; title: string }[] = [];
      if (blockerIds.length > 0) {
        const blockerIssues = await crudRepo.getBlockerIssues(blockerIds, database);

        blockedBy = blockerIssues
          .filter(b => !isResolvedDependencyStatusView({ statusName: b.statusName, currentNodeId: b.currentNodeId, currentNodeType: b.currentNodeType }))
          .map(b => ({ issueNumber: b.issueNumber!, title: b.title }));
      }

      // 12. Derive expected worktree ports from the branch name (null for direct workspaces)
      let ports: { serverPort: number; clientPort: number } | null = null;
      if (!isDirect && branch) {
        ports = derivePortsFromBranch(branch);
      }

      // 13. Budget estimation (non-blocking — never throws)
      const budgetEstimate = await estimateBudget(database, input.issueId, agentConfig.resolvedProvider).catch(
        () => ({
          risk: "low" as const,
          estimatedTokens: null,
          avgTokensFromHistory: null,
          sessionCount: 0,
          descriptionTokens: 0,
          reason: "Estimation unavailable",
        }),
      );

      // 14. Multi-repo fan-out preview (#91): for a multi-repo project, list the leading
      //     worktree plus each additional-repo worktree, marking which the selected
      //     `repoScope` will actually provision. null for single-repo projects and direct
      //     workspaces (no worktree fan-out) so the selector/preview stays hidden there.
      let multiRepo: {
        leadingRepoName: string;
        worktrees: { id: string; name: string; leading: boolean; selected: boolean; hasServiceStack: boolean }[];
      } | null = null;
      if (!isDirect) {
        const projectRepos = await listProjectRepos(issue.projectId, database).catch(() => []);
        if (projectRepos.length > 0) {
          const leadingRepoName = basename(project.repoPath) || project.repoPath;
          // #629: the preview must resolve the scope the SAME way the launch does, or the
          // dialog shows 17 repos selected for a launch that will provision one. That is the
          // failure this module's header warns about — a preview that re-derives its own
          // answer is a preview that can lie about the launch.
          const effectiveScope = resolveEffectiveRepoScope({
            explicit: input.repoScope,
            reposTouched: await getIssueReposTouched(input.issueId, database),
            leadingRepoName,
          });
          const scopedIds = new Set(resolveScopedSiblingRepos(projectRepos, effectiveScope).map((r) => r.id));
          multiRepo = {
            leadingRepoName,
            worktrees: [
              // The leading repo is always provisioned; a project-level service stack
              // (servicesConfig) rides its worktree.
              {
                id: "__leading__",
                name: leadingRepoName,
                leading: true,
                selected: true,
                hasServiceStack: Boolean(project.servicesConfig && project.servicesConfig.trim()),
              },
              ...projectRepos.map((r) => ({
                id: r.id,
                name: r.name ?? basename(r.path),
                leading: false,
                selected: scopedIds.has(r.id),
                hasServiceStack: Boolean(r.composeFile && r.composeFile.trim()),
              })),
            ],
          };
        }
      }

      return {
        branch,
        baseBranch,
        isDirect,
        planMode,
        tddMode,
        requiresReview,
        setupScript,
        skill,
        provider: agentConfig.resolvedProvider,
        profile: agentConfig.resolvedProfile ?? agentConfig.resolvedProfileSelection?.name ?? null,
        model: agentConfig.model ?? null,
        warnings,
        budgetEstimate,
        ports,
        blockedBy,
        multiRepo,
      };
  }

  return { computeLaunchPreview };
}
