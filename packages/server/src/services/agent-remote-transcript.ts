/**
 * Keeps a REMOTE session's stdout on the board (#1333).
 *
 * A host session's stdout is written to the per-session `.out` file by agent.service.ts and
 * `/api/sessions/:id/output`, the transcript panel and session search read it from there. A
 * remote session's events arrive over the worker socket and went only to the broadcaster
 * (which persists non-stdout rows), so the transcript was just the exit event. Appending each
 * streamed stdout chunk to the SAME `.out` file makes a remote session indistinguishable from
 * a host one to every reader.
 *
 * Fire-and-forget by contract: a failed write must never break event delivery.
 */
import { appendFileSync } from "node:fs";
import { sessionOutputPath } from "@agentic-kanban/shared/lib/session-files";
import type { AgentOutputCallback } from "./agent.service.js";

/** Persist a streamed event's stdout, then hand it to the session's output callback; a throwing callback is logged, never propagated. */
export function deliverRemoteOutput(
  onOutput: AgentOutputCallback,
  event: Parameters<AgentOutputCallback>[0],
): void {
  persistRemoteStdout(event);
  try {
    onOutput(event);
  } catch (err) {
    console.error(`[agent-remote] output callback error: sessionId=${event.sessionId}`, err);
  }
}

export function persistRemoteStdout(event: { type: string; sessionId: string; data?: string }): void {
  if (event.type !== "stdout" || !event.data) return;
  try {
    appendFileSync(sessionOutputPath(event.sessionId), event.data, "utf-8");
  } catch (err) {
    console.warn(`[agent-remote] could not persist stdout for session ${event.sessionId}:`, err);
  }
}
