import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { sessionOutputPath } from "./session-paths.js";

/**
 * Filesystem adapter for the per-session `.out` stdout transcript files that
 * detached agents stream to (see agent.service.ts). This is infrastructure I/O,
 * NOT persistence — it deliberately lives in lib/ (an adapter seam), out of the
 * repositories/ layer, so the persistence boundary stays pure DB access. The
 * `repositories-are-infra-pure` lint:arch rule enforces that separation.
 */

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
