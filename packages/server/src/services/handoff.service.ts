import { existsSync } from "node:fs";
import { readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLatestCommit, getDiffShortstat, getChangedFileNames } from "./git.service.js";
import { parseSessionSummary } from "@agentic-kanban/shared";
import { sessionMessages, sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";

const HANDOFF_FILENAME = "HANDOFF.md";
const MAX_FILES = 20;
const MAX_ERRORS = 5;
const MAX_SUMMARY_CHARS = 500;
const MAX_HANDOFF_BYTES = 4096;

interface HandoffData {
  lastCommit: { sha: string; message: string } | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  agentSummary: string | null;
  changedFiles: string[];
  filesModified: string[];
  errors: string[];
  model: string;
  durationMs: number;
  costUsd: number;
}

function truncateList(items: string[], max: number): string[] {
  return items.slice(0, max);
}

function truncateText(text: string | null, maxChars: number): string | null {
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "...";
}

function finalSummary(summary: string | null, fallback: string | null): string | null {
  const source = summary || fallback;
  if (!source) return null;
  const parts = source
    .split("\n\n---\n\n")
    .map(part => part.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || source.trim();
}

export async function generateHandoff(
  workingDir: string,
  sessionId: string,
  database: Database,
  baseBranch?: string | null,
): Promise<string> {
  const diffBase = baseBranch || "HEAD~1";
  const [lastCommit, diffStatsResult, changedFilesResult, sessionRows, messageRows] = await Promise.all([
    getLatestCommit(workingDir).catch(() => null),
    getDiffShortstat(workingDir, diffBase).catch(() => null),
    getChangedFileNames(workingDir, diffBase).catch(() => []),
    database.select({ stats: sessions.stats }).from(sessions).where(eq(sessions.id, sessionId)).limit(1),
    database.select({ type: sessionMessages.type, data: sessionMessages.data }).from(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)),
  ]);

  const summary = parseSessionSummary(messageRows);
  const statsJson = sessionRows[0]?.stats;
  let parsedStats: Record<string, unknown> = {};
  if (statsJson) {
    try { parsedStats = JSON.parse(statsJson); } catch { /* ignore */ }
  }

  const data: HandoffData = {
    lastCommit,
    diffStats: diffStatsResult,
    agentSummary: truncateText(finalSummary(summary.agentSummary, (parsedStats.agentSummary as string) || null), MAX_SUMMARY_CHARS),
    changedFiles: changedFilesResult,
    filesModified: [...new Set([...summary.filesEdited, ...summary.filesWritten])],
    errors: summary.errors,
    model: summary.model || (parsedStats.model as string) || "",
    durationMs: (parsedStats.durationMs as number) || 0,
    costUsd: (parsedStats.totalCostUsd as number) || 0,
  };

  return buildHandoffMarkdown(data);
}

function buildHandoffMarkdown(data: HandoffData): string {
  const lines: string[] = ["# Session Handoff", ""];

  if (data.lastCommit) {
    lines.push("## Last Commit");
    lines.push(`- **${data.lastCommit.sha}**: ${data.lastCommit.message}`);
    lines.push("");
  }

  if (data.diffStats && (data.diffStats.filesChanged > 0 || data.diffStats.insertions > 0 || data.diffStats.deletions > 0)) {
    lines.push("## Files Changed (since base)");
    lines.push(`- ${data.diffStats.filesChanged} file(s), +${data.diffStats.insertions} / -${data.diffStats.deletions}`);
    lines.push("");
  }

  if (data.changedFiles.length > 0) {
    lines.push("## Current Changed Files");
    for (const f of truncateList(data.changedFiles, MAX_FILES)) {
      lines.push(`- \`${f}\``);
    }
    if (data.changedFiles.length > MAX_FILES) {
      lines.push(`- ... and ${data.changedFiles.length - MAX_FILES} more`);
    }
    lines.push("");
  }

  if (data.filesModified.length > 0) {
    lines.push("## Files Modified By Previous Session");
    for (const f of truncateList(data.filesModified, MAX_FILES)) {
      lines.push(`- \`${f}\``);
    }
    if (data.filesModified.length > MAX_FILES) {
      lines.push(`- ... and ${data.filesModified.length - MAX_FILES} more`);
    }
    lines.push("");
  }

  if (data.errors.length > 0) {
    lines.push("## Known Errors");
    for (const err of truncateList(data.errors, MAX_ERRORS)) {
      lines.push(`- ${err}`);
    }
    if (data.errors.length > MAX_ERRORS) {
      lines.push(`- ... and ${data.errors.length - MAX_ERRORS} more`);
    }
    lines.push("");
  }

  if (data.agentSummary) {
    lines.push("## Session Summary");
    lines.push(data.agentSummary);
    lines.push("");
  }

  if (data.model || data.durationMs || data.costUsd) {
    lines.push("## Session Stats");
    if (data.model) lines.push(`- Model: ${data.model}`);
    if (data.durationMs) {
      const sec = Math.floor(data.durationMs / 1000);
      const min = Math.floor(sec / 60);
      lines.push(`- Duration: ${min > 0 ? `${min}m ${sec % 60}s` : `${sec}s`}`);
    }
    if (data.costUsd) lines.push(`- Cost: $${data.costUsd.toFixed(2)}`);
    lines.push("");
  }

  let result = lines.join("\n").trim() + "\n";

  // Cap total size
  if (Buffer.byteLength(result, "utf8") > MAX_HANDOFF_BYTES) {
    result = result.slice(0, MAX_HANDOFF_BYTES) + "\n\n(truncated)\n";
  }

  return result;
}

export async function writeHandoffFile(
  workingDir: string,
  sessionId: string,
  database: Database,
  baseBranch?: string | null,
): Promise<void> {
  const content = await generateHandoff(workingDir, sessionId, database, baseBranch);
  const handoffPath = join(workingDir, HANDOFF_FILENAME);
  await writeFile(handoffPath, content, "utf8");

  // Ensure HANDOFF.md is in .gitignore
  const gitignorePath = join(workingDir, ".gitignore");
  try {
    let gitignoreContent = "";
    if (existsSync(gitignorePath)) {
      gitignoreContent = await readFile(gitignorePath, "utf8");
    }
    if (!gitignoreContent.split("\n").some(line => line.trim() === HANDOFF_FILENAME)) {
      const prefix = gitignoreContent && !gitignoreContent.endsWith("\n") ? "\n" : "";
      await appendFile(gitignorePath, `${prefix}${HANDOFF_FILENAME}\n`, "utf8");
    }
  } catch {
    // Best-effort — don't fail the handoff write if gitignore update fails
  }
}

export async function readHandoffFile(workingDir: string): Promise<string | null> {
  const handoffPath = join(workingDir, HANDOFF_FILENAME);
  try {
    if (!existsSync(handoffPath)) return null;
    return await readFile(handoffPath, "utf8");
  } catch {
    return null;
  }
}
