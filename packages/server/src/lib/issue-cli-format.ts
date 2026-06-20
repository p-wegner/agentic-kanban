// Pure presentation helpers for the `issue` CLI commands. Each returns the lines
// to print (the caller does the console.log) so the formatting is unit-testable
// with exact-string assertions and kept out of the giant command handlers.

import type { SessionSummary } from "@agentic-kanban/shared";

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
