import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";

// Single source of truth for the on-disk capture files of a detached agent session
// and the readers over them. Detached agents (claude on Windows — see
// agent.service.ts) redirect stdout to a per-session `.out` file and stderr to a
// `.err` sibling. BOTH the server (repositories/services) and the mcp-server need
// to derive these paths and read them; this module is a node-only LEAF (like
// git-service.ts) consumed via the deep import `@agentic-kanban/shared/lib/
// session-files` — it is deliberately NOT re-exported from the shared `lib` barrel
// (which the client bundles), so node:fs/os never reaches the browser.
//
// Previously the path scheme + readSessionStdoutFile were forked: a server copy
// (lib/session-paths.ts + lib/session-output-reader.ts) and a hand-maintained
// mcp-server copy (db-utils.ts, literally commented "kept in sync manually"). Any
// change to the filename scheme silently broke MCP. Consolidated here so the
// scheme lives once.

/** Get the stdout output file path for a session. */
export function sessionOutputPath(sessionId: string): string {
  return join(tmpdir(), `kanban-session-${sessionId}.out`);
}

/**
 * Get the stderr capture file path for a detached session.
 *
 * Detached agents redirect stdout to the `.out` file, but stderr used to be
 * discarded (`stdio[2] = "ignore"`). When the provider process dies BEFORE emitting
 * any stdout (e.g. claude.exe exits 1 immediately from a fix-and-merge launch in a
 * mid-rebase / conflicted worktree), the `.out` file is 0 bytes and the only
 * diagnostic — the reason on stderr — was thrown away, producing an invisible
 * "0-token zombie" (#779). We now redirect stderr to this file so the failure is
 * debuggable.
 */
export function sessionErrorPath(sessionId: string): string {
  return join(tmpdir(), `kanban-session-${sessionId}.err`);
}

/**
 * Read stdout content from the per-session .out file, or null when absent.
 */
export function readSessionStdoutFile(sessionId: string): string | null {
  const outPath = sessionOutputPath(sessionId);
  if (!existsSync(outPath)) return null;
  try {
    const content = readFileSync(outPath, "utf-8");
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Read at most the last `maxBytes` bytes of the per-session .out file, or null
 * when the file is absent or empty. Bounded alternative to readSessionStdoutFile
 * for hot polling paths (agent-questions): the terminal `result` event is one of
 * the LAST JSONL lines, so the tail is sufficient — reading whole multi-MB
 * transcripts synchronously blocked the event loop for 150ms+ per poll.
 * When the read is truncated, the (likely partial) first line of the window is
 * dropped so callers only ever see complete JSONL lines.
 */
export function readSessionStdoutFileTail(
  sessionId: string,
  maxBytes = 256 * 1024,
): string | null {
  const outPath = sessionOutputPath(sessionId);
  let fd: number;
  try {
    fd = openSync(outPath, "r");
  } catch {
    return null; // absent (or unreadable) — caller falls back to DB rows
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, start);
    let content = buf.toString("utf-8", 0, bytesRead);
    if (start > 0) {
      // Truncated mid-line: drop everything before the first newline.
      const nl = content.indexOf("\n");
      content = nl === -1 ? "" : content.slice(nl + 1);
    }
    return content || null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
