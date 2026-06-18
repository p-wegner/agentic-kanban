import { randomUUID } from "node:crypto";
import { parseSessionSummary } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import * as realGitService from "./git.service.js";
import { WorkspaceError, type GitService } from "./workspace-internals.js";
import { readSessionStdoutFile, getSessionMessageRows } from "../repositories/session.repository.js";
import {
  getHandoffWorkspaceContext,
  getHandoffSessionRows,
  getHandoffSessionMessageRows,
  getHandoffDiffComments,
  insertHandoffArtifact,
  getHandoffWorkspaceIssueId,
  getLatestHandoffArtifact,
} from "../repositories/github-handoff-draft.repository.js";

export const GITHUB_HANDOFF_DRAFT_CAPTION = "github-handoff-draft";

const MAX_LIST_ITEMS = 40;
const MAX_NOTE_CHARS = 700;

export interface GithubHandoffDraftInput {
  issue: {
    issueNumber?: number | null;
    title: string;
    statusName?: string | null;
  };
  workspace: {
    branch: string;
    baseBranch?: string | null;
    mergedAt?: string | null;
    closedAt?: string | null;
  };
  commits?: Array<{ sha: string; message: string }>;
  changedFiles?: string[];
  testsRun?: string[];
  agentSummary?: string | null;
  reviewerNotes?: string[];
}

function issueReference(issue: GithubHandoffDraftInput["issue"]): string {
  return issue.issueNumber ? `#${issue.issueNumber} ${issue.title}` : issue.title;
}

function truncateText(text: string, max = MAX_NOTE_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}...`;
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function appendList(lines: string[], values: string[], emptyText: string, format = (value: string) => `- ${value}`) {
  if (values.length === 0) {
    lines.push(`- ${emptyText}`);
    return;
  }
  for (const value of values.slice(0, MAX_LIST_ITEMS)) lines.push(format(value));
  if (values.length > MAX_LIST_ITEMS) lines.push(`- ... and ${values.length - MAX_LIST_ITEMS} more`);
}

function finalSummary(summary: string | null | undefined): string | null {
  if (!summary?.trim()) return null;
  const parts = summary
    .split("\n\n---\n\n")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] ?? summary.trim();
}

function looksLikeVerificationCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return /\b(test|vitest|playwright|e2e|lint|tsc|typecheck|check)\b/.test(normalized);
}

export function buildGithubHandoffDraft(input: GithubHandoffDraftInput): string {
  const commits = input.commits ?? [];
  const changedFiles = input.changedFiles ?? [];
  const testsRun = uniqueNonEmpty(input.testsRun ?? []);
  const reviewerNotes = uniqueNonEmpty(input.reviewerNotes ?? []);
  const summary = finalSummary(input.agentSummary);

  const lines: string[] = [
    `# GitHub Handoff Draft: ${issueReference(input.issue)}`,
    "",
    "## Summary",
  ];
  lines.push(summary ? summary : "- Not recorded.");
  lines.push("");

  lines.push("## Issue");
  lines.push(`- ${issueReference(input.issue)}`);
  if (input.issue.statusName) lines.push(`- Status: ${input.issue.statusName}`);
  lines.push("");

  lines.push("## Branch / Commits");
  lines.push(`- Branch: \`${input.workspace.branch}\``);
  if (input.workspace.baseBranch) lines.push(`- Base: \`${input.workspace.baseBranch}\``);
  if (input.workspace.mergedAt) lines.push(`- Merged: ${input.workspace.mergedAt}`);
  else if (input.workspace.closedAt) lines.push(`- Closed: ${input.workspace.closedAt}`);
  appendList(
    lines,
    commits.map((commit) => `\`${commit.sha}\`${commit.message ? ` ${commit.message}` : ""}`),
    "No commits recorded.",
  );
  lines.push("");

  lines.push("## Changed Files");
  appendList(lines, changedFiles, "No changed files recorded.", (file) => `- \`${file}\``);
  lines.push("");

  lines.push("## Verification");
  appendList(lines, testsRun, "Not recorded.", (command) => `- \`${command}\``);
  lines.push("");

  if (reviewerNotes.length > 0) {
    lines.push("## Reviewer Notes");
    appendList(lines, reviewerNotes.map((note) => truncateText(note)), "None.");
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function generateGithubHandoffDraft(args: {
  workspaceId: string;
  database: Database;
  repoPath?: string;
  fromRef?: string;
  toRef?: string;
  changedFiles?: string[];
  commits?: Array<{ sha: string; message: string }>;
  gitService?: GitService;
}): Promise<string> {
  const { workspaceId, database } = args;
  const gitService = args.gitService ?? realGitService;

  const row = await getHandoffWorkspaceContext(workspaceId, database);
  if (!row) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
  if (row.status !== "closed") {
    throw new WorkspaceError("GitHub handoff drafts can only be generated for closed workspaces", "BAD_REQUEST");
  }

  const sessionRows = await getHandoffSessionRows(workspaceId, database);
  const sessionIds = sessionRows.map((session) => session.id);
  let messageRows: Array<{ type: string; data: string | null; sessionId: string }> = [];
  if (sessionIds.length > 0) {
    const needsDb: string[] = [];
    for (const sid of sessionIds) {
      const fileContent = readSessionStdoutFile(sid);
      if (fileContent !== null) {
        messageRows.push({ type: "stdout", data: fileContent, sessionId: sid });
      } else {
        needsDb.push(sid);
      }
    }
    if (needsDb.length > 0) {
      const dbRows = await getHandoffSessionMessageRows(needsDb, database);
      messageRows = messageRows.concat(dbRows);
    }
  }
  const summary = parseSessionSummary(messageRows);
  const statsSummary = sessionRows
    .map((session) => {
      if (!session.stats) return null;
      try {
        const parsed = JSON.parse(session.stats) as { agentSummary?: unknown };
        return typeof parsed.agentSummary === "string" ? parsed.agentSummary : null;
      } catch {
        return null;
      }
    })
    .find(Boolean) ?? null;

  const reviewNotes = await collectReviewerNotes(database, workspaceId, sessionRows);
  const repoPath = args.repoPath ?? row.repoPath;
  const fromRef = args.fromRef ?? row.baseCommitSha ?? "";
  const toRef = args.toRef ?? "HEAD";
  const changedFiles = args.changedFiles
    ?? (repoPath && fromRef ? await gitService.getChangedFilesBetween(repoPath, fromRef, toRef) : []);
  const commits = args.commits
    ?? (repoPath && fromRef && typeof gitService.getCommitSummariesBetween === "function"
      ? await gitService.getCommitSummariesBetween(repoPath, fromRef, toRef)
      : []);

  return buildGithubHandoffDraft({
    issue: { issueNumber: row.issueNumber, title: row.title, statusName: row.statusName },
    workspace: {
      branch: row.branch,
      baseBranch: row.baseBranch,
      mergedAt: row.mergedAt,
      closedAt: row.closedAt,
    },
    commits,
    changedFiles,
    testsRun: summary.commandsRun.filter(looksLikeVerificationCommand),
    agentSummary: finalSummary(summary.agentSummary) ?? statsSummary,
    reviewerNotes: reviewNotes,
  });
}

async function collectReviewerNotes(
  database: Database,
  workspaceId: string,
  sessionRows: Array<{ id: string; triggerType: string | null; stats: string | null }>,
): Promise<string[]> {
  const comments = await getHandoffDiffComments(workspaceId, database);

  const notes = comments.map((comment) => {
    const location = comment.lineNumNew ? `${comment.filePath}:${comment.lineNumNew}` : comment.filePath;
    return `${location}: ${comment.body}`;
  });

  for (const session of sessionRows.filter((row) => row.triggerType === "review")) {
    const rows = await getSessionMessageRows(session.id, database);
    const summary = finalSummary(parseSessionSummary(rows).agentSummary);
    if (summary) notes.push(summary);
  }

  return notes;
}

export async function persistGithubHandoffDraft(args: {
  workspaceId: string;
  issueId: string;
  content: string;
  database: Database;
}): Promise<{ artifactId: string }> {
  const artifactId = randomUUID();
  await insertHandoffArtifact({
    id: artifactId,
    issueId: args.issueId,
    workspaceId: args.workspaceId,
    type: "text",
    mimeType: "text/markdown",
    content: args.content,
    caption: GITHUB_HANDOFF_DRAFT_CAPTION,
  }, args.database);
  return { artifactId };
}

export async function generateAndPersistGithubHandoffDraft(args: {
  workspaceId: string;
  issueId?: string;
  database: Database;
  repoPath?: string;
  fromRef?: string;
  toRef?: string;
  changedFiles?: string[];
  commits?: Array<{ sha: string; message: string }>;
  gitService?: GitService;
}): Promise<{ artifactId: string; content: string }> {
  const issueId = args.issueId ?? await getHandoffWorkspaceIssueId(args.workspaceId, args.database);
  if (!issueId) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

  const content = await generateGithubHandoffDraft(args);
  const { artifactId } = await persistGithubHandoffDraft({
    workspaceId: args.workspaceId,
    issueId,
    content,
    database: args.database,
  });
  return { artifactId, content };
}

export async function getLatestGithubHandoffDraft(args: {
  workspaceId: string;
  database: Database;
}): Promise<{ artifactId: string; content: string; createdAt: string } | null> {
  const row = await getLatestHandoffArtifact(args.workspaceId, GITHUB_HANDOFF_DRAFT_CAPTION, args.database);
  return row ? { artifactId: row.id, content: row.content, createdAt: row.createdAt } : null;
}
