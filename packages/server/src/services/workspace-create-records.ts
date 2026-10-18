// Row-level helpers of workspace creation (issue/project lookup, workspace + setup/symlink run inserts,
// open-direct and ticket-group guards), split out of workspace-create.service.ts (#1605).
import { projectDepsLiveOnWorker } from "./worker-deps-placement.js";
import { type Database, type TransactionClient } from "../db/index.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import type { ProviderName } from "./agent-provider.js";
import { type LatestSetupRun, type LatestSymlinkRun } from "./workspace-run-records.js";
import { parseSymlinkDirs } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import { filterIssuesWithLiveGroupWorkspace } from "../repositories/workspace-issue-members.repository.js";
import { WorkspaceError, type CreateWorkspaceInput } from "./workspace-internals.js";
import { insertWorkspaceSetupRun } from "../repositories/workspace-setup-run.repository.js";
import { insertWorkspaceSymlinkRun } from "../repositories/workspace-symlink-run.repository.js";

export function createWorkspaceCreateRecords(database: Database) {
  async function resolveIssueAndProject(issueId: string): Promise<{
    issue: { id?: string; projectId: string; issueNumber: number | null; title: string; description: string | null; priority: string | null; externalKey: string | null };
    project: { repoPath: string; defaultBranch: string | null; defaultSkillId: string | null; servicesConfig: string | null };
    setupConfig: { setupScript: string | null; setupBlocking: boolean; setupEnabled: boolean; depsOnWorker: boolean };
    symlinkConfig: { enabled: boolean; dirs: string[] };
  }> {
    const issueRows = await crudRepo.getIssueForWorkspaceCreate(issueId, database);

    if (issueRows.length === 0) {
      throw new WorkspaceError("Issue not found", "NOT_FOUND");
    }

    const issue = issueRows[0];

    const projectRows = await crudRepo.getProjectForWorkspaceCreate(issue.projectId, database);

    if (projectRows.length === 0) {
      throw new WorkspaceError("Project not found", "NOT_FOUND");
    }

    const projectRow = projectRows[0];
    return {
      issue,
      project: { repoPath: projectRow.repoPath, defaultBranch: projectRow.defaultBranch, defaultSkillId: projectRow.defaultSkillId ?? null, servicesConfig: projectRow.servicesConfig ?? null },
      setupConfig: {
        setupScript: projectRow.setupScript ?? null,
        setupBlocking: projectRow.setupBlocking ?? true,
        setupEnabled: projectRow.setupEnabled ?? true, depsOnWorker: await projectDepsLiveOnWorker(issue.projectId, database), // #1429
      },
      symlinkConfig: {
        enabled: projectRow.symlinkEnabled ?? false,
        dirs: parseSymlinkDirs(projectRow.symlinkDirs),
      },
    };
  }

  async function insertWorkspaceRecord(params: {
    id: string;
    issueId: string;
    branch: string;
    worktreePath: string | null;
    baseBranch: string | null;
    isDirect: boolean;
    baseCommitSha: string | null;
    requiresReview: boolean;
    thoroughReview: boolean;
    planMode: boolean;
    tddMode: boolean;
    includeVisualProof: boolean;
    skillId: string | null;
    claudeProfile: string | undefined;
    agentCommand: string | undefined;
    resolvedProvider: ProviderName;
    model: string | undefined;
    contextPrimer: string | null;
    serviceState: string | null;
    latestSetup: LatestSetupRun;
    latestSymlink: LatestSymlinkRun;
    now: string;
    database?: Database | TransactionClient;
    /** Defaults to "active" — pass "blocked" when a blocking setup script failed (#169). */
    status?: string;
  }): Promise<void> {
    await crudRepo.insertWorkspaceRecordRow({
      id: params.id,
      issueId: params.issueId,
      branch: params.branch,
      workingDir: params.worktreePath,
      baseBranch: params.baseBranch,
      isDirect: params.isDirect,
      baseCommitSha: params.baseCommitSha,
      requiresReview: params.requiresReview,
      thoroughReview: params.thoroughReview,
      planMode: params.planMode,
      tddMode: params.tddMode,
      includeVisualProof: params.includeVisualProof,
      skillId: params.skillId,
      status: params.status ?? "active",
      claudeProfile: params.claudeProfile ?? null,
      agentCommand: params.agentCommand ?? null,
      provider: params.resolvedProvider,
      model: params.model ?? null,
      contextPrimer: params.contextPrimer,
      serviceState: params.serviceState,
      createdAt: params.now,
      updatedAt: params.now,
    }, params.database ?? database);
    // #815: the setup run is its own table now — same handle, so it lands in the same
    // transaction as the workspace row. Written even for the `state: "skipped"` run a
    // project with no setup script produces: that is what the eight columns held, and the
    // projection distinguishes it from "no record at all".
    await insertWorkspaceSetupRun(params.id, {
      command: params.latestSetup.command,
      state: params.latestSetup.state,
      startedAt: params.latestSetup.startedAt,
      endedAt: params.latestSetup.endedAt,
      exitCode: params.latestSetup.exitCode,
      durationMs: params.latestSetup.durationMs,
      stdoutTail: params.latestSetup.stdoutTail,
      stderrTail: params.latestSetup.stderrTail,
    }, params.database ?? database);
    // #798: the symlink run is its own table now — written with the same handle, so it is
    // in the same transaction as the workspace row when the caller passes one. Written even
    // for the `state: "disabled"` run a project with the feature off produces: the columns
    // always carried it, and the diagnostics panel distinguishes "disabled" from "pending".
    await insertWorkspaceSymlinkRun(params.id, {
      state: params.latestSymlink.state,
      startedAt: params.latestSymlink.startedAt,
      endedAt: params.latestSymlink.endedAt,
      dirs: JSON.stringify(params.latestSymlink.dirs),
      linked: JSON.stringify(params.latestSymlink.linked),
      skipped: JSON.stringify(params.latestSymlink.skipped),
      failed: JSON.stringify(params.latestSymlink.failed),
      error: params.latestSymlink.error,
    }, params.database ?? database);
  }

  async function assertNoOpenDirectWorkspaceForIssue(issueId: string): Promise<void> {
    const openDirectRows = await crudRepo.findOpenDirectWorkspacesForIssue(issueId, database);

    if (openDirectRows.length === 0) return;

    const first = openDirectRows[0];
    const extraCount = Math.max(0, openDirectRows.length - 1);
    const suffix = extraCount > 0 ? ` and ${extraCount} other open direct workspace(s)` : "";
    throw new WorkspaceError(
      `Issue already has an open direct workspace (${first.id}, branch ${first.branch}, status ${first.status}${first.updatedAt ? `, updated ${first.updatedAt}` : ""})${suffix}. Close or delete the existing direct workspace before creating another workspace; direct workspaces share the main checkout.`,
      "CONFLICT",
      { code: "OPEN_DIRECT_WORKSPACE", workspaceId: first.id, status: first.status, branch: first.branch },
    );
  }

  /**
   * Ticket group (#661): validate and resolve the group's MEMBER issues. Members must
   * exist, belong to the lead's project, and not already be served — by an open
   * workspace of their own or by another live group. Duplicates and the lead itself
   * are dropped silently (callers may pass a whole coupled component).
   */
  async function resolveGroupMembers(
    input: CreateWorkspaceInput,
    leadProjectId: string,
  ): Promise<Array<{ id: string; issueNumber: number | null; title: string; description: string | null }>> {
    const unique = [...new Set(input.memberIssueIds ?? [])].filter((memberId) => memberId && memberId !== input.issueId);
    if (unique.length === 0) return [];

    const members: Array<{ id: string; issueNumber: number | null; title: string; description: string | null }> = [];
    for (const memberId of unique) {
      const rows = await crudRepo.getIssueForWorkspaceCreate(memberId, database);
      if (rows.length === 0) {
        throw new WorkspaceError(`Ticket-group member issue not found: ${memberId}`, "NOT_FOUND");
      }
      const member = rows[0];
      if (member.projectId !== leadProjectId) {
        throw new WorkspaceError(
          `Ticket-group member ${memberId} belongs to a different project than the lead issue — a group shares one worktree, so all members must live in one project.`,
          "CONFLICT",
          { code: "GROUP_MEMBER_WRONG_PROJECT", issueId: memberId },
        );
      }
      members.push({ id: memberId, issueNumber: member.issueNumber, title: member.title, description: member.description });
    }

    const openOwn = await crudRepo.findOpenWorkspacesForIssues(unique, database);
    if (openOwn.length > 0) {
      throw new WorkspaceError(
        `Ticket-group member already has an open workspace (issue ${openOwn[0].issueId} → workspace ${openOwn[0].id}, branch ${openOwn[0].branch}). Close it first, or start the group without that member.`,
        "CONFLICT",
        { code: "GROUP_MEMBER_HAS_WORKSPACE", workspaceId: openOwn[0].id, issueId: openOwn[0].issueId },
      );
    }
    const inLiveGroup = await filterIssuesWithLiveGroupWorkspace(unique, database);
    if (inLiveGroup.size > 0) {
      const first = [...inLiveGroup][0];
      throw new WorkspaceError(
        `Ticket-group member ${first} is already served as a member of another live group workspace.`,
        "CONFLICT",
        { code: "GROUP_MEMBER_IN_LIVE_GROUP", issueId: first },
      );
    }
    return members;
  }

  return { resolveIssueAndProject, insertWorkspaceRecord, assertNoOpenDirectWorkspaceForIssue, resolveGroupMembers };
}
