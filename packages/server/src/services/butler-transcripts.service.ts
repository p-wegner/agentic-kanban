/**
 * Butler transcript service — surfaces past butler conversations in the UI by
 * reading the Claude Agent SDK JSONL transcripts on disk.
 *
 * The Claude Agent SDK writes per-session JSONL files to:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *
 * Encoding scheme: replace all `:`, `\`, and `/` characters in the cwd with `-`.
 * E.g. `C:\code\my-app` → `C--code-my-app`
 *
 * Parsing is delegated to the SHARED offline transcript reader
 * (`@agentic-kanban/shared/lib/offline-transcript`), which routes each line
 * through the canonical per-provider stream parser — the single source of
 * transcript-format knowledge (arch-review §2.4). The butler is always a Claude
 * SDK session, so we pass `provider: "claude"` and `requireSdkEntrypoint: true`
 * (older SDK versions wrote `entrypoint: "sdk-cli"`, newer ones `"cli"`; both
 * accepted by the reader).
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { readOfflineTranscript } from "@agentic-kanban/shared/lib/offline-transcript";

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

const EPOCH0 = new Date(0).toISOString();

/**
 * Parse a JSONL transcript file into a session summary via the shared reader.
 * Returns null if the file has no SDK-CLI entries (not a butler transcript).
 */
async function parseSessionFile(filePath: string, sessionId: string): Promise<ButlerSessionSummary | null> {
  const transcript = await readOfflineTranscript(filePath, {
    provider: "claude",
    requireSdkEntrypoint: true,
  });
  if (!transcript.hasSdkEntrypoint) return null;

  // ai-title if available, else first user message truncated to 60 chars.
  let title = transcript.aiTitle ?? "";
  if (!title) {
    const firstUser = transcript.messages.find((m) => m.role === "user");
    if (firstUser) {
      title = firstUser.text.length > 60 ? `${firstUser.text.slice(0, 57)}…` : firstUser.text;
    }
  }
  if (!title) title = sessionId.slice(0, 8);

  return {
    sessionId,
    startedAt: transcript.firstTimestamp ?? EPOCH0,
    endedAt: transcript.lastTimestamp ?? transcript.firstTimestamp ?? EPOCH0,
    title,
    turnCount: transcript.userTurnCount,
    model: transcript.model ?? undefined,
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
 * Parse a single session's JSONL into user/assistant message pairs via the
 * shared reader. Tool-use, tool-result, and thinking blocks are excluded.
 */
export async function getButlerSessionMessages(
  repoPath: string,
  sessionId: string,
): Promise<ButlerSessionMessage[]> {
  const dir = resolveTranscriptDir(repoPath);
  const filePath = join(dir, `${sessionId}.jsonl`);
  const transcript = await readOfflineTranscript(filePath, {
    provider: "claude",
    requireSdkEntrypoint: true,
  });
  return transcript.messages;
}
