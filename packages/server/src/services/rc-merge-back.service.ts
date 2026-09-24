/**
 * The **merge-back** workspace (#1239 item 3, decision 019 part 2).
 *
 * A promoted release candidate carries whatever was healed on it, and master does not: the fix
 * reaches master through the board's OWN merge, never by a hand-run `git merge`. `pnpm promote`
 * used to print that command; it now POSTs here (`POST /api/projects/:id/rc/merge-back`), and
 * prints the command only as the fallback when no board answers.
 *
 * The workspace is ordinary in every respect the merge path cares about: its BRANCH is the rc
 * itself (`createWorktree` adopts an existing branch), its BASE is the project default branch,
 * so `update-base` rebases the rc onto master, the diff is rc-vs-master, the pre-merge gate runs
 * the normal selection for that diff, and a conflict is a normal reconcile on that workspace.
 * When the candidate carried no heal the merge is a clean-ancestor no-op that the merge path
 * short-circuits to Done, which is the honest record that nothing needed merging back.
 *
 * Its issue is keyed `rc-merge-back:<projectId>:<rc>` (`heal-ticket-key.ts`), which is what
 * `finalizeMergeCleanup` recognises to close the rc's heal tickets when the landing is verified.
 * One per candidate: a second request for the same rc returns the open one.
 */
import { LEGACY_TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { mergeBackExternalKey } from "../lib/heal-ticket-key.js";
import { getProjectById } from "../repositories/project.repository.js";
import { listIssuesByExternalKey } from "../repositories/issue/heal-ticket.repository.js";
import { listOpenWorkspacesForIssue } from "../repositories/workspace-heal.repository.js";
import { createIssueService, type CreateIssueInput, type CreateIssueResult } from "./issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";
import { isRcBranch } from "./heal-gate-forcing.js";

export interface MergeBackRequest {
  projectId: string;
  rcBranch: string;
  /** The `stable-*` tag the rc was promoted as, for the ticket text. */
  tag?: string | null;
}

export interface MergeBackResult {
  issueId: string;
  issueNumber: number | null;
  workspaceId: string;
  /** False when an open merge-back for this rc already existed and was returned instead. */
  created: boolean;
}

export interface MergeBackDeps {
  database?: Database;
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<Pick<CreateWorkspaceResult, "id">>;
}

export class MergeBackError extends Error {
  constructor(message: string, public readonly status: 400 | 404 = 400) {
    super(message);
  }
}

/** The prompt the merge-back workspace's agent is launched with: there is nothing to build. */
export function mergeBackPrompt(rcBranch: string, baseBranch: string): string {
  return [
    `This workspace is the MERGE-BACK of the promoted release candidate \`${rcBranch}\` into \`${baseBranch}\` (#1239).`,
    `There is nothing to implement. Do not edit files. If the branch does not rebase cleanly onto \`${baseBranch}\`,`,
    `resolve the conflicts (keep both the candidate's heal and master's landings), commit, and stop. Otherwise stop at once.`,
  ].join("\n");
}

export async function createRcMergeBackWorkspace(request: MergeBackRequest, deps: MergeBackDeps): Promise<MergeBackResult> {
  const database = deps.database ?? db;
  if (!isRcBranch(request.rcBranch)) throw new MergeBackError(`'${request.rcBranch}' is not a release-candidate branch (rc/<date>[-N])`);
  const project = await getProjectById(request.projectId, database);
  if (!project) throw new MergeBackError("Project not found", 404);
  if (!project.defaultBranch) throw new MergeBackError("Project has no default branch to merge the candidate back into");

  const externalKey = mergeBackExternalKey(request.projectId, request.rcBranch);
  const existing = (await listIssuesByExternalKey(request.projectId, externalKey, database))
    .find((row) => !LEGACY_TERMINAL_STATUS_NAMES.has(row.statusName ?? ""));
  if (existing) {
    const open = await listOpenWorkspacesForIssue(existing.id, database);
    if (open.length > 0) {
      console.log(`[rc-merge-back] ${request.rcBranch}: merge-back #${existing.issueNumber} already open on workspace ${open[0].id}`);
      return { issueId: existing.id, issueNumber: existing.issueNumber, workspaceId: open[0].id, created: false };
    }
  }

  const issue = existing ?? await (deps.createIssue ?? createIssueService({ database }).createIssue)({
    projectId: request.projectId,
    title: `merge-back: ${request.rcBranch} into ${project.defaultBranch}${request.tag ? ` (${request.tag})` : ""}`,
    description: [
      `Land the promoted release candidate \`${request.rcBranch}\` on \`${project.defaultBranch}\` through the board (decision 019, #1239).`,
      ``,
      `- The workspace's branch IS the candidate; its base is \`${project.defaultBranch}\`.`,
      `- The pre-merge gate runs as for any workspace; a rebase conflict is a normal reconcile here.`,
      `- Landing it closes the candidate's open \`heal\` tickets.`,
      request.tag ? `- Promoted as \`${request.tag}\`.` : ``,
    ].filter(Boolean).join("\n"),
    issueType: "task",
    priority: "high",
    externalKey,
    // Not auto-started as a builder ticket: the workspace below is created by this call.
    tags: ["merge-back", "no-auto-start"],
  });

  const workspace = await deps.createWorkspace({
    issueId: issue.id,
    branch: request.rcBranch,
    baseBranch: project.defaultBranch,
    requiresReview: false,
    skipContextPacker: true,
    customPrompt: mergeBackPrompt(request.rcBranch, project.defaultBranch),
  });
  console.log(`[rc-merge-back] ${request.rcBranch}: merge-back #${issue.issueNumber ?? "?"} on workspace ${workspace.id} (base ${project.defaultBranch})`);
  return { issueId: issue.id, issueNumber: issue.issueNumber ?? null, workspaceId: workspace.id, created: true };
}
