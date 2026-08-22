/**
 * Ship the ticket-context files to a TRUE-REMOTE fleet worker (#749).
 *
 * `writeWorktreeTicketContext` writes `CLAUDE.local.md` into the BOARD's worktree. That is
 * how a claude builder gets its brief (Claude Code auto-loads the file as project memory)
 * and how a copilot builder gets it (`--attachment <path>`). A true-remote worker works in
 * a clone of its own, so on that path the file simply was not there: #524 fixed codex by
 * appending the CONTENTS to the prompt — the only channel codex has — and left claude and
 * copilot with no context at all, silently, looking like models that ignored their brief.
 *
 * Paths cannot travel (they name nothing on the worker), so the CONTENT does: name +
 * content pairs the worker writes into its checkout root, where both providers find them
 * exactly as they would in a board worktree.
 *
 * The content is not shipped verbatim. The board rendered it for the BOARD's deployment,
 * including the board-feedback routing ("file a ticket with `create_issue`"), which on a
 * worker is an instruction to use tools that do not exist there. It is retargeted first —
 * see `retargetTicketContextForRemoteWorker`.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  TICKET_CONTEXT_FILENAME,
  retargetTicketContextForRemoteWorker,
} from "@agentic-kanban/shared/lib/ticket-context";
import { BOARD_ISSUES_URL } from "./board-feedback-routing.js";

export interface RemoteContextFile {
  name: string;
  content: string;
}

export interface BuildRemoteContextFilesOptions {
  /** Where a board bug goes when the reporter has no board tools. Defaults to the board's. */
  issuesUrl?: string;
  /** Injectable for tests; defaults to a real read. */
  readFile?: (path: string) => string;
}

/**
 * Read the board-side context files and project them into wire form.
 *
 * A file that cannot be read is skipped with a warning, never fatal — same rule as
 * `appendContextFilesToPrompt`: a missing context file degrades the brief, it does not fail
 * the launch.
 */
export function buildRemoteContextFiles(
  contextFiles: string[] | undefined,
  options: BuildRemoteContextFilesOptions = {},
): RemoteContextFile[] {
  if (!contextFiles?.length) return [];
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const issuesUrl = options.issuesUrl ?? BOARD_ISSUES_URL;
  const out: RemoteContextFile[] = [];
  for (const path of contextFiles) {
    let content: string;
    try {
      content = read(path);
    } catch (err) {
      console.warn(`[agent-remote] failed to read context file for a remote worker: file=${path}`, err);
      continue;
    }
    if (!content.trim()) continue;
    const name = basename(path.replace(/\\/g, "/"));
    out.push({
      name,
      content: name === TICKET_CONTEXT_FILENAME
        ? retargetTicketContextForRemoteWorker(content, { issuesUrl })
        : content,
    });
  }
  return out;
}
