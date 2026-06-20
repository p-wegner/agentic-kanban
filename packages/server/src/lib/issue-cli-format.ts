// Pure presentation + input-validation helpers for the `issue` CLI commands.
// Renderers return the lines to print (the caller does the console.log) and
// validators return the first error message (the caller does console.error +
// process.exit), so the formatting/validation is unit-testable with exact-string
// assertions and kept out of the giant command handlers.

import { formatDurationStr, type SessionSummary } from "@agentic-kanban/shared";

export interface IssueSummaryRenderInput {
  num: number;
  title: string;
  workspace: { branch: string | null; status: string } | null;
  sessionStatus: string;
  duration: string | null;
  stats: Record<string, unknown> | null;
  summary: SessionSummary;
}

/**
 * Build the human-readable `issue summary` output as an array of lines. Printing
 * each line with console.log reproduces the original handler's output byte-for-byte
 * (embedded leading "\n" preserved for the blank-line separators).
 */
export function buildIssueSummaryLines(input: IssueSummaryRenderInput): string[] {
  const { num, title, workspace, sessionStatus, duration, stats, summary } = input;
  const lines: string[] = [];

  lines.push(`\n  #${num} ${title}`);

  if (workspace) {
    lines.push(`  workspace: ${workspace.branch} (${workspace.status})`);
  }

  lines.push(`  session: ${sessionStatus}  duration: ${duration ?? "?"}`);

  if (stats) {
    const s = stats as any;
    const parts: string[] = [];
    if (s.model ?? summary.model) parts.push(`model: ${s.model ?? summary.model}`);
    if (s.numTurns > 0) parts.push(`turns: ${s.numTurns}`);
    if (s.totalCostUsd > 0) parts.push(`cost: $${s.totalCostUsd.toFixed(2)}`);
    if (s.inputTokens > 0 || s.outputTokens > 0) parts.push(`tokens: ${s.inputTokens ?? 0} in / ${s.outputTokens ?? 0} out`);
    if (parts.length > 0) lines.push(`  ${parts.join("  ")}`);
  }

  if (summary.overview) {
    lines.push(`  ${summary.overview}`);
  }

  if (summary.agentSummary) {
    lines.push(`\n  Agent summary:`);
    for (const line of summary.agentSummary.split("\n")) {
      lines.push(`    ${line}`);
    }
  }

  const allFiles = [...new Set([...summary.filesRead, ...summary.filesEdited, ...summary.filesWritten])];
  if (allFiles.length > 0) {
    lines.push(`\n  Files (${allFiles.length}):`);
    for (const f of allFiles) {
      const tags: string[] = [];
      if (summary.filesEdited.includes(f)) tags.push("edited");
      if (summary.filesWritten.includes(f)) tags.push("written");
      if (summary.filesRead.includes(f) && tags.length === 0) tags.push("read");
      lines.push(`    ${f} (${tags.join(", ")})`);
    }
  }

  if (summary.commandsRun.length > 0) {
    lines.push(`\n  Commands (${summary.commandsRun.length}):`);
    for (const cmd of summary.commandsRun.slice(0, 10)) {
      lines.push(`    ${cmd}`);
    }
    if (summary.commandsRun.length > 10) {
      lines.push(`    ... and ${summary.commandsRun.length - 10} more`);
    }
  }

  if (summary.errors.length > 0) {
    lines.push(`\n  Errors (${summary.errors.length}):`);
    for (const err of summary.errors.slice(0, 5)) {
      lines.push(`    ${err}`);
    }
  }

  lines.push("");

  return lines;
}

export interface IssueStatusRenderInput {
  num: number;
  title: string;
  statusName: string;
  issueType: string | null;
  workspace: { id: string; branch: string | null; status: string; isDirect: boolean; provider: string | null } | null;
  session: { id: string; status: string; startedAt: string; endedAt: string | null } | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  fileChanges: { read: number; edited: number; written: number } | null;
  lastAgentMessage: string | null;
  /** Injected clock (caller passes Date.now()) so the "N ago" line is testable. */
  nowMs: number;
}

/**
 * Build the human-readable `issue status` output as an array of lines. Printing
 * each line with console.log reproduces the original handler output byte-for-byte.
 */
export function buildIssueStatusLines(input: IssueStatusRenderInput): string[] {
  const { num, title, statusName, issueType, workspace, session, diffStats, fileChanges, lastAgentMessage, nowMs } = input;
  const lines: string[] = [];

  lines.push(`\n  #${num} ${title}`);
  lines.push(`  Status: ${statusName} · Type: ${issueType ?? "task"}`);

  if (workspace) {
    const wsType = workspace.isDirect ? "direct" : "worktree";
    const parts = [workspace.branch, wsType, workspace.status];
    if (workspace.provider) parts.push(workspace.provider);
    lines.push(`  Workspace: ${workspace.id.slice(0, 8)} (${parts.join(", ")})`);
  }

  if (session) {
    const agoMs = nowMs - new Date(session.startedAt).getTime();
    const ago = formatDurationStr(agoMs);
    let duration = "?";
    if (session.endedAt && session.startedAt) {
      duration = formatDurationStr(new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime());
    }
    lines.push(`  Session:  ${session.id.slice(0, 8)} (${session.status}, ${ago} ago, lasted ${duration})`);
  }

  if (diffStats && (diffStats.filesChanged > 0 || diffStats.insertions > 0 || diffStats.deletions > 0)) {
    lines.push(`  Diff: ${diffStats.filesChanged} file${diffStats.filesChanged === 1 ? "" : "s"}, +${diffStats.insertions}/-${diffStats.deletions}`);
  } else if (fileChanges && (fileChanges.read || fileChanges.edited || fileChanges.written)) {
    const parts: string[] = [];
    if (fileChanges.read) parts.push(`${fileChanges.read} read`);
    if (fileChanges.edited) parts.push(`${fileChanges.edited} edited`);
    if (fileChanges.written) parts.push(`${fileChanges.written} written`);
    lines.push(`  Files: ${parts.join(", ")}`);
  } else {
    lines.push("  No file changes.");
  }

  if (lastAgentMessage) {
    lines.push(`\n  Last agent message:`);
    const wrapped = lastAgentMessage.length > 200 ? lastAgentMessage.slice(0, 197) + "..." : lastAgentMessage;
    for (const line of wrapped.split("\n")) {
      lines.push(`    ${line}`);
    }
  }
  lines.push("");

  return lines;
}

export type ArtifactType = "text" | "link" | "image";

/** Artifact types the CLI accepts. Intentionally NO "video" (the MCP tool allows it; the CLI does not). */
export const ARTIFACT_TYPES: readonly ArtifactType[] = ["text", "link", "image"];

/** Validate `issue attach-artifact` inputs; returns the first error message, else the parsed values. */
export function validateAttachArtifactOptions(
  issueNumberArg: string,
  options: { type?: string; content?: string },
): { ok: true; num: number; type: ArtifactType; content: string } | { ok: false; error: string } {
  const num = Number(issueNumberArg);
  if (!Number.isInteger(num) || num <= 0) {
    return { ok: false, error: `Invalid issue number: ${issueNumberArg}` };
  }
  if (!options.type) {
    return { ok: false, error: "--type is required. Valid: text, link, image" };
  }
  if (!(ARTIFACT_TYPES as readonly string[]).includes(options.type)) {
    return { ok: false, error: `Invalid type '${options.type}'. Valid: ${ARTIFACT_TYPES.join(", ")}` };
  }
  if (!options.content || !options.content.trim()) {
    return { ok: false, error: "--content is required and cannot be empty." };
  }
  return { ok: true, num, type: options.type as ArtifactType, content: options.content };
}

export interface AttachArtifactResult {
  id: string;
  issueId: string;
  workspaceId: string | null;
  type: string;
  mimeType: string | null;
  caption: string | null;
}

/** Build `issue attach-artifact` output lines (JSON blob, or the human confirmation). */
export function formatAttachArtifactOutput(result: AttachArtifactResult, num: number, json: boolean): string[] {
  if (json) return [JSON.stringify(result, null, 2)];
  const lines = [`Attached ${result.type} artifact to issue #${num}.`, `  id: ${result.id}`];
  if (result.caption) lines.push(`  caption: ${result.caption}`);
  return lines;
}
