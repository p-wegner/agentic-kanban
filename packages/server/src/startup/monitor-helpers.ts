import { sessionMessages } from "@agentic-kanban/shared/schema";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";

export type MonitorAction = {
  at: string;
  action: MonitorActionName;
  workspaceId: string;
  issueId: string;
  /** HTTP endpoint called for this action, e.g. /api/workspaces/:id/merge */
  endpoint?: string;
  /** HTTP response status code, e.g. 200, 409 */
  httpStatus?: number;
  /** Truncated response body summary (max 200 chars) */
  responseSummary?: string;
  /** Post-action verification: did the state change as expected? */
  verificationResult?: "ok" | "failed" | "skipped";
};

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

export async function getRecentAgentExcerpts(sessionId: string, count = 3): Promise<string[]> {
  const rows = await db.select({ data: sessionMessages.data }).from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId)).orderBy(desc(sessionMessages.id)).limit(50);
  const excerpts: string[] = [];
  for (const row of rows) {
    if (!row.data || excerpts.length >= count) break;
    const lines = row.data.split("\n").reverse();
    for (const line of lines) {
      if (excerpts.length >= count) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(trimmed); } catch { continue; }
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
