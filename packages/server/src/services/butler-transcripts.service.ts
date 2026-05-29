/**
 * Butler transcript service — parses Claude Agent SDK JSONL transcripts from disk
 * to surface past butler conversations in the UI.
 *
 * The Claude Agent SDK writes per-session JSONL files to:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * Encoding scheme: replace all `:`, `\`, and `/` characters in the cwd with `-`.
 * E.g. `C:\andrena\agentic-kanban` → `C--andrena-agentic-kanban`
 *
 * Each line is a JSON object. Relevant entries:
 *   - `{ type: "user", entrypoint: "sdk-cli", message: { role: "user", content: string }, timestamp: ISO, sessionId }`
 *   - `{ type: "assistant", entrypoint: "sdk-cli", message: { model, content: Array<{type,text}> }, timestamp: ISO, sessionId }`
 *   - `{ type: "ai-title", aiTitle: string, sessionId }`
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ButlerSessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  title: string;
  turnCount: number;
  model?: string;
}

export interface ButlerSessionMessage {
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** Convert a filesystem path to Claude's project directory name encoding. */
function encodeCwd(cwd: string): string {
  // Claude replaces `:`, `\`, and `/` all with `-`
  return cwd.replace(/[:\\/]/g, "-");
}

/** Resolve the Claude projects transcript directory for the given repo path. */
export function resolveTranscriptDir(repoPath: string): string {
  const encoded = encodeCwd(repoPath);
  return join(homedir(), ".claude", "projects", encoded);
}

interface JsonlEntry {
  type?: string;
  entrypoint?: string;
  sessionId?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string; thinking?: string }>;
    model?: string;
  };
  aiTitle?: string;
}

function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    return JSON.parse(line) as JsonlEntry;
  } catch {
    return null;
  }
}

function extractTextFromContent(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  for (const block of content) {
    if (block.type === "text" && block.text) return block.text;
  }
  return "";
}

/**
 * Parse a JSONL transcript file and return a session summary.
 * Returns null if the file has no sdk-cli entries.
 */
async function parseSessionFile(filePath: string, sessionId: string): Promise<ButlerSessionSummary | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  let hasSdkCli = false;
  let startedAt = "";
  let endedAt = "";
  let title = "";
  let turnCount = 0;
  let model: string | undefined;
  let firstUserText = "";

  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseJsonlEntry(line);
    if (!entry) continue;

    if (entry.type === "ai-title" && entry.aiTitle) {
      title = entry.aiTitle;
    }

    if (entry.entrypoint !== "sdk-cli") continue;
    hasSdkCli = true;

    if (entry.type === "user" && entry.message?.role === "user") {
      turnCount++;
      if (entry.timestamp) {
        if (!startedAt) startedAt = entry.timestamp;
        endedAt = entry.timestamp;
      }
      if (!firstUserText && entry.message.content) {
        firstUserText = typeof entry.message.content === "string"
          ? entry.message.content
          : extractTextFromContent(entry.message.content);
      }
    }

    if (entry.type === "assistant" && entry.message?.model && !model) {
      model = entry.message.model;
    }
    if (entry.type === "assistant" && entry.timestamp) {
      endedAt = entry.timestamp;
    }
  }

  if (!hasSdkCli) return null;

  // Use ai-title if available, else first user message truncated to 60 chars
  if (!title && firstUserText) {
    title = firstUserText.length > 60 ? `${firstUserText.slice(0, 57)}…` : firstUserText;
  }
  if (!title) title = sessionId.slice(0, 8);

  return {
    sessionId,
    startedAt: startedAt || new Date(0).toISOString(),
    endedAt: endedAt || startedAt || new Date(0).toISOString(),
    title,
    turnCount,
    model,
  };
}

/**
 * List recent butler sessions by scanning the JSONL transcript directory.
 * Filters to entries that are in `allowedSessionIds` (butler-tracked IDs).
 * Returns up to `limit` sessions sorted by mtime descending.
 */
export async function listButlerSessions(
  repoPath: string,
  allowedSessionIds: Set<string>,
  limit = 5,
): Promise<ButlerSessionSummary[]> {
  const dir = resolveTranscriptDir(repoPath);

  let files: Array<{ name: string; mtime: Date }>;
  try {
    const entries = await readdir(dir);
    const stats = await Promise.all(
      entries
        .filter((e) => e.endsWith(".jsonl"))
        .map(async (name) => {
          try {
            const s = await stat(join(dir, name));
            return { name, mtime: s.mtime };
          } catch {
            return null;
          }
        }),
    );
    files = stats.filter((s): s is { name: string; mtime: Date } => s !== null);
  } catch {
    return [];
  }

  // Sort by mtime descending, then filter to butler-tracked sessions
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const results: ButlerSessionSummary[] = [];
  for (const { name } of files) {
    if (results.length >= limit) break;
    const sessionId = name.slice(0, -6); // remove .jsonl
    if (!allowedSessionIds.has(sessionId)) continue;
    const summary = await parseSessionFile(join(dir, name), sessionId);
    if (summary) results.push(summary);
  }

  return results;
}

/**
 * Parse a single session's JSONL into user/assistant message pairs.
 * Skips tool-use, tool-result, and thinking blocks.
 */
export async function getButlerSessionMessages(
  repoPath: string,
  sessionId: string,
): Promise<ButlerSessionMessage[]> {
  const dir = resolveTranscriptDir(repoPath);
  const filePath = join(dir, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const messages: ButlerSessionMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseJsonlEntry(line);
    if (!entry || entry.entrypoint !== "sdk-cli") continue;

    if (entry.type === "user" && entry.message?.role === "user") {
      const text = typeof entry.message.content === "string"
        ? entry.message.content
        : extractTextFromContent(entry.message.content);
      if (text.trim()) {
        messages.push({
          role: "user",
          text,
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
        });
      }
    } else if (entry.type === "assistant") {
      const text = extractTextFromContent(entry.message?.content);
      if (text.trim()) {
        messages.push({
          role: "assistant",
          text,
          ts: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
        });
      }
    }
  }

  return messages;
}
