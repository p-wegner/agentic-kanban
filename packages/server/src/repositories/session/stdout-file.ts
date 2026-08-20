import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { readSessionStdoutFile } from "../../lib/session-output-reader.js";

// The per-session .out transcript readers (readSessionStdoutFile /
// readSessionStdoutFileTail) are a filesystem ADAPTER, not persistence — they
// live in lib/session-output-reader.ts so this repository stays pure DB access
// (enforced by the repositories-are-infra-pure lint:arch rule). Re-exported here
// for back-compat is intentionally avoided: callers import the adapter directly.

/**
 * Read stdout messages from the per-session .out file. Returns an array of
 * AgentOutputMessage rows (type="stdout") reconstructed from the raw chunks,
 * or an empty array when the file is absent (e.g. old sessions before this change).
 *
 * Internal to the session repository: shared by the message reads (./messages.ts)
 * and the summary read (./stats.ts). Lives in ONE module so both sides read the
 * same file-or-DB rule — never duplicated.
 */
export function readStdoutFromFile(sessionId: string): AgentOutputMessage[] {
  const content = readSessionStdoutFile(sessionId);
  if (!content) return [];
  return [{ type: "stdout", sessionId, data: content }];
}
