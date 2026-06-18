import type { db } from "../db/index.js";
import type { workspaces } from "@agentic-kanban/shared/schema";
import { detectConflicts } from "./git.service.js";
import { getWorkspaceDiffStats } from "./workspace-diff-stats.js";
import { extractMeaningfulOutput } from "@agentic-kanban/shared";
import type { BoardStatusIssue } from "@agentic-kanban/shared";
import { readSessionStdoutFile } from "../repositories/session.repository.js";
import { getRecentSessionMessages } from "../repositories/board-status-enrichment.repository.js";
import { parseAgentMessageFromJsonLine, parseLastAgentMessage } from "./session-message-parser.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

export interface ConflictCacheEntry {
  result: { hasConflicts: boolean; conflictingFiles: string[] };
  ts: number;
}

export interface BoardStatusEnrichmentContext {
  defaultBranch: string | null;
  database: typeof db;
  tailLines: number;
  conflictCache: Map<string, ConflictCacheEntry>;
  conflictCacheTtl: number;
}

/**
 * Collects the async tasks that enrich a board-status entry for a non-closed
 * workspace with a workingDir: diff stats, conflict detection (cached,
 * non-blocking), and last session output / agent message. Mutates `entry`
 * in place. Returns the promises so the caller can await them together via
 * Promise.all (preserving parallel execution across all entries); conflict
 * cache hits are applied synchronously and produce no promise.
 */
export function collectBoardStatusEntryWork(
  entry: BoardStatusIssue,
  mainWs: WorkspaceRow,
  latestSessionId: string | null,
  context: BoardStatusEnrichmentContext,
): Promise<void>[] {
  const { defaultBranch, database, tailLines, conflictCache, conflictCacheTtl } = context;
  const workingDir = mainWs.workingDir;
  if (!workingDir || mainWs.status === "closed") return [];

  const work: Promise<void>[] = [];
  const baseBranch = mainWs.baseBranch || defaultBranch;

  work.push(
    getWorkspaceDiffStats(mainWs, defaultBranch)
      .then(stats => { entry.diffStats = stats; })
      .catch((err) => { console.error(`[board-status] diff failed for ${mainWs.branch}:`, err instanceof Error ? err.message : String(err)); }),
  );

  // Conflict detection for non-direct idle workspaces (cached, non-blocking)
  if (!mainWs.isDirect && mainWs.status === "idle" && baseBranch) {
    const cached = conflictCache.get(mainWs.id);
    if (cached && Date.now() - cached.ts < conflictCacheTtl) {
      entry.conflicts = cached.result;
    } else {
      work.push(
        detectConflicts(workingDir, baseBranch)
          .then(result => {
            conflictCache.set(mainWs.id, { result, ts: Date.now() });
            entry.conflicts = result;
          })
          .catch(() => { /* non-critical */ }),
      );
    }
  }

  if (latestSessionId) {
    work.push(loadLastSessionOutput(entry, latestSessionId, database, tailLines));
  }

  return work;
}

/**
 * Fills entry.lastOutput / entry.lastAgentMessage / entry.lastActivity from
 * the session's .out file when present, falling back to DB rows for
 * historical sessions.
 */
async function loadLastSessionOutput(
  entry: BoardStatusIssue,
  sessionId: string,
  database: typeof db,
  tailLines: number,
): Promise<void> {
  // Try .out file first; fall back to DB rows for historical sessions
  const fileContent = readSessionStdoutFile(sessionId);
  if (fileContent !== null) {
    const stdoutRows = [{ type: "stdout" as const, data: fileContent, createdAt: null }];
    entry.lastOutput = extractMeaningfulOutput(stdoutRows, tailLines);
    // Parse JSONL for last agent message (file is in chronological order; scan in reverse)
    entry.lastAgentMessage = parseLastAgentMessage(fileContent.split("\n"));
    return;
  }

  const msgs = await getRecentSessionMessages(sessionId, database);

  if (msgs.length > 0 && msgs[0].createdAt) {
    entry.lastActivity = msgs[0].createdAt;
  }

  const chronological = msgs.reverse();
  entry.lastOutput = extractMeaningfulOutput(chronological, tailLines);

  for (const msg of chronological) {
    if (msg.type !== "stdout" || !msg.data) continue;
    for (const line of msg.data.split("\n")) {
      const message = parseAgentMessageFromJsonLine(line);
      if (message) {
        entry.lastAgentMessage = message;
        break;
      }
    }
    if (entry.lastAgentMessage) break;
  }
}
