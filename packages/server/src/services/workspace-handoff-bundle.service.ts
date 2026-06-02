import { and, desc, eq, inArray } from "drizzle-orm";
import { diffComments, issues, projects, projectStatuses, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { parseSessionSummary } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import * as realGitService from "./git.service.js";
import { WorkspaceError, type GitService } from "./workspace-internals.js";

export interface WorkspaceHandoffBundle {
  exportedAt: string;
  workspace: {
    id: string;
    branch: string;
    baseBranch: string | null;
    status: string;
    isDirect: boolean;
    createdAt: string;
    closedAt: string | null;
    mergedAt: string | null;
    workingDir: string | null;
  };
  issue: {
    issueNumber: number | null;
    title: string;
    description: string | null;
    statusName: string | null;
  };
  latestCommit: { sha: string; message: string } | null;
  changedFiles: string[];
  diffStats: { additions: number; deletions: number; files: number } | null;
  agentSummary: string | null;
  commandsRun: string[];
  filesEdited: string[];
  errors: string[];
  reviewerNotes: string[];
  sessions: Array<{
    id: string;
    triggerType: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
    exitCode: string | null;
  }>;
}

function parseDiffStatsFromDiff(diff: string): { additions: number; deletions: number; files: number } | null {
  if (!diff) return null;
  const files = (diff.match(/^diff --git /gm) ?? []).length;
  const additions = (diff.match(/^\+(?!\+\+)/gm) ?? []).length;
  const deletions = (diff.match(/^-(?!--)/gm) ?? []).length;
  return { files, additions, deletions };
}

export async function exportWorkspaceHandoffBundle(args: {
  workspaceId: string;
  database: Database;
  gitService?: GitService;
}): Promise<WorkspaceHandoffBundle> {
  const { workspaceId, database } = args;
  const gitService = args.gitService ?? realGitService;

  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueDescription: issues.description,
      statusName: projectStatuses.name,
      repoPath: projects.repoPath,
      defaultBranch: projects.defaultBranch,
      wsId: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      baseCommitSha: workspaces.baseCommitSha,
      status: workspaces.status,
      isDirect: workspaces.isDirect,
      workingDir: workspaces.workingDir,
      createdAt: workspaces.createdAt,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

  const sessionRows = await database
    .select({
      id: sessions.id,
      triggerType: sessions.triggerType,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      exitCode: sessions.exitCode,
    })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt));

  const sessionIds = sessionRows.map((s) => s.id);
  const messageRows = sessionIds.length === 0
    ? []
    : await database
        .select({ type: sessionMessages.type, data: sessionMessages.data, sessionId: sessionMessages.sessionId })
        .from(sessionMessages)
        .where(inArray(sessionMessages.sessionId, sessionIds));

  const summary = parseSessionSummary(messageRows);

  const commentRows = await database
    .select({ filePath: diffComments.filePath, lineNumNew: diffComments.lineNumNew, body: diffComments.body })
    .from(diffComments)
    .where(and(eq(diffComments.workspaceId, workspaceId)))
    .orderBy(diffComments.createdAt);
  const reviewerNotes = commentRows.map((c) => {
    const location = c.lineNumNew ? `${c.filePath}:${c.lineNumNew}` : c.filePath;
    return `${location}: ${c.body}`;
  });

  const repoPath = row.repoPath;
  const fromRef = row.baseCommitSha ?? "";
  const toRef = "HEAD";

  let changedFiles: string[] = [];
  let latestCommit: { sha: string; message: string } | null = null;
  let diffStats: { additions: number; deletions: number; files: number } | null = null;

  if (repoPath && row.workingDir) {
    try {
      if (fromRef) {
        changedFiles = await gitService.getChangedFilesBetween(repoPath, fromRef, toRef);
      }
    } catch {
      // non-fatal
    }
    try {
      const commit = await gitService.getLatestCommit(row.workingDir);
      latestCommit = commit ?? null;
    } catch {
      // non-fatal
    }
    try {
      const baseBranch = row.baseBranch ?? row.defaultBranch ?? "";
      if (baseBranch) {
        const diff = await gitService.getDiff(row.workingDir, baseBranch);
        diffStats = parseDiffStatsFromDiff(diff);
      }
    } catch {
      // non-fatal
    }
  }

  return {
    exportedAt: new Date().toISOString(),
    workspace: {
      id: row.wsId,
      branch: row.branch,
      baseBranch: row.baseBranch,
      status: row.status,
      isDirect: !!row.isDirect,
      createdAt: row.createdAt,
      closedAt: row.closedAt,
      mergedAt: row.mergedAt,
      workingDir: row.workingDir,
    },
    issue: {
      issueNumber: row.issueNumber,
      title: row.issueTitle,
      description: row.issueDescription,
      statusName: row.statusName,
    },
    latestCommit,
    changedFiles,
    diffStats,
    agentSummary: summary.agentSummary ?? null,
    commandsRun: summary.commandsRun,
    filesEdited: summary.filesEdited,
    errors: summary.errors,
    reviewerNotes,
    sessions: sessionRows.map((s) => ({
      id: s.id,
      triggerType: s.triggerType,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      exitCode: s.exitCode,
    })),
  };
}

export function renderHandoffBundleAsMarkdown(bundle: WorkspaceHandoffBundle): string {
  const issue = bundle.issue;
  const ws = bundle.workspace;
  const ref = issue.issueNumber ? `#${issue.issueNumber} ${issue.title}` : issue.title;

  const lines: string[] = [
    `# Workspace Handoff Bundle: ${ref}`,
    "",
    `> Exported ${bundle.exportedAt}`,
    "",
    "## Issue",
    `- **Title:** ${issue.title}`,
    ...(issue.issueNumber ? [`- **Number:** #${issue.issueNumber}`] : []),
    ...(issue.statusName ? [`- **Status:** ${issue.statusName}`] : []),
    ...(issue.description ? ["", issue.description] : []),
    "",
    "## Workspace",
    `- **Branch:** \`${ws.branch}\``,
    ...(ws.baseBranch ? [`- **Base:** \`${ws.baseBranch}\``] : []),
    `- **Status:** ${ws.status}`,
    `- **Created:** ${ws.createdAt}`,
    ...(ws.mergedAt ? [`- **Merged:** ${ws.mergedAt}`] : ws.closedAt ? [`- **Closed:** ${ws.closedAt}`] : []),
    "",
    "## Latest Commit",
    bundle.latestCommit
      ? `- \`${bundle.latestCommit.sha}\` ${bundle.latestCommit.message}`
      : "- No commits recorded.",
    "",
    "## Changed Files",
  ];

  if (bundle.changedFiles.length === 0) {
    lines.push("- No changed files recorded.");
  } else {
    for (const f of bundle.changedFiles.slice(0, 50)) lines.push(`- \`${f}\``);
    if (bundle.changedFiles.length > 50) lines.push(`- ... and ${bundle.changedFiles.length - 50} more`);
  }

  if (bundle.diffStats) {
    lines.push("", `**Diff:** +${bundle.diffStats.additions} -${bundle.diffStats.deletions} across ${bundle.diffStats.files} file(s)`);
  }

  lines.push("", "## Agent Summary");
  lines.push(bundle.agentSummary ? bundle.agentSummary : "- Not recorded.");

  if (bundle.errors.length > 0) {
    lines.push("", "## Errors");
    for (const e of bundle.errors) lines.push(`- ${e}`);
  }

  if (bundle.reviewerNotes.length > 0) {
    lines.push("", "## Reviewer Notes");
    for (const n of bundle.reviewerNotes) lines.push(`- ${n}`);
  }

  lines.push("", "## Sessions");
  if (bundle.sessions.length === 0) {
    lines.push("- No sessions recorded.");
  } else {
    for (const s of bundle.sessions) {
      const duration = s.startedAt && s.endedAt
        ? `${Math.round((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 1000)}s`
        : "running";
      lines.push(`- ${s.triggerType ?? "agent"} | ${s.status} | ${duration} | exit: ${s.exitCode ?? "—"}`);
    }
  }

  return `${lines.join("\n").trim()}\n`;
}
