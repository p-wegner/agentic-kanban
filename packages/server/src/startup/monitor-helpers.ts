import { sessionMessages } from "@agentic-kanban/shared/schema";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import type { MonitorAction } from "@agentic-kanban/shared/types";
import { readSessionStdoutFileTailAsync } from "../lib/session-output-reader.js";

/**
 * How much of a session transcript's tail the monitor reads for its nudge excerpts.
 * Generous for three assistant messages, and bounded — which is the whole point.
 */
const MONITOR_EXCERPT_TAIL_BYTES = 512 * 1024;

// Shape lives in shared (#567) so the client's ACTION_LABELS maps type-check against it.
export type { MonitorAction };

export function logMonitorAction(
  recentActions: MonitorAction[],
  action: MonitorActionName,
  workspaceId: string,
  issueId: string,
  extra?: Pick<MonitorAction, "endpoint" | "httpStatus" | "responseSummary" | "verificationResult">,
) {
  recentActions.unshift({ at: new Date().toISOString(), action, workspaceId, issueId, ...extra });
  if (recentActions.length > 30) recentActions.splice(30);
}

/**
 * The newest few assistant text blocks for a session, for the monitor's nudge prompt.
 *
 * #359 — this read the WHOLE `.out` transcript synchronously (`readSessionStdoutFile`) on the
 * `processing-candidates` path, for every long-running workspace that had already been nudged, on
 * every cycle. Those transcripts routinely reach multiple MB; `readSessionStdoutFileTail`'s own
 * doc-comment records that reading them whole "blocked the event loop for 150ms+ per poll", and
 * that block is a direct contributor to the measured bimodal `/api/health` (9 of 24 samples under
 * 15ms, 8 over 3s — the signature of long synchronous blocks, not of load).
 *
 * The bounded tail is not a compromise here: the wanted blocks are the NEWEST ones, which are at
 * the END of the file. The one behaviour change is a transcript whose last 512 KB happens to
 * contain no assistant text at all — so an empty result now FALLS THROUGH to the DB rows instead
 * of returning `[]`, which is strictly more complete than the old full read was.
 */
export async function getRecentAgentExcerpts(sessionId: string, count = 3): Promise<string[]> {
  const excerpts: string[] = [];

  // Try .out file first (reversed for newest-first traversal). Async (#401): the
  // 512 KB tail read runs through fs.promises so a monitor cycle over many
  // long-running workspaces never blocks the event loop on file I/O.
  const fileContent = await readSessionStdoutFileTailAsync(sessionId, MONITOR_EXCERPT_TAIL_BYTES);
  if (fileContent !== null) {
    const lines = fileContent.split("\n").reverse();
    for (const line of lines) {
      if (excerpts.length >= count) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
      if (obj.type !== "assistant") continue;
      const content = ((obj.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) || [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          excerpts.push((block.text as string).slice(0, 500));
          if (excerpts.length >= count) break;
        }
      }
    }
    // Only return early when the tail actually yielded something: an empty result is ambiguous
    // between "no assistant output" and "the tail window held none", and the DB rows can answer.
    if (excerpts.length > 0) return excerpts;
  }

  // Fall back to DB for historical sessions
  const rows = await db.select({ data: sessionMessages.data }).from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId)).orderBy(desc(sessionMessages.id)).limit(50);
  for (const row of rows) {
    if (!row.data || excerpts.length >= count) break;
    const lines = row.data.split("\n").reverse();
    for (const line of lines) {
      if (excerpts.length >= count) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
      if (obj.type !== "assistant") continue;
      const content = ((obj.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) || [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          excerpts.push((block.text as string).slice(0, 500));
          if (excerpts.length >= count) break;
        }
      }
    }
  }
  return excerpts;
}

export function shouldSkipNudge(excerpts: string[]): boolean {
  if (excerpts.length === 0) return false;
  const combined = excerpts.join(" ").toLowerCase();
  const activeSignals = ["i'll now", "i will now", "let me now", "next i'll", "continuing", "i'm now", "proceeding to", "moving on to", "i've completed"];
  const waitingSignals = ["?", "please let me know", "should i", "would you like", "do you want", "waiting", "what would", "can you", "could you", "i need your"];
  const hasWaiting = waitingSignals.some((s) => combined.includes(s));
  if (hasWaiting) return false;
  return activeSignals.some((s) => combined.includes(s));
}
