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
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  TICKET_CONTEXT_FILENAME,
  announceRemoteBoardTools,
  retargetTicketContextForRemoteWorker,
} from "@agentic-kanban/shared/lib/ticket-context";
import { BOARD_ISSUES_URL } from "./board-feedback-routing.js";
import type { Database } from "../db/index.js";
import { findFleetMcpAssignment } from "../repositories/worker.repository.js";

export interface RemoteContextFile {
  name: string;
  content: string;
}

/**
 * Rewrite the ticket brief for a remote worker that DOES have the board bridge (#749, #1332):
 * name the tools that work and the assignment's own issue/project ids. A failed issue lookup
 * only drops the issue id line; the bridge still defaults to it.
 */
export async function announceRemoteBridgeInBrief(
  files: RemoteContextFile[],
  boardTools: Parameters<typeof announceRemoteBoardTools>[1]["boardTools"],
  projectId: string,
  sessionId: string,
  database: Database,
): Promise<void> {
  const issueId = (await findFleetMcpAssignment(sessionId, database).catch(() => null))?.issueId;
  for (const file of files) {
    if (file.name !== TICKET_CONTEXT_FILENAME) continue;
    file.content = announceRemoteAssignmentIdentity(announceRemoteBoardTools(file.content, { boardTools }), { projectId, issueId });
  }
}

/**
 * Name the assignment's own issue and project in the brief (#1332).
 *
 * A host builder's `CLAUDE.local.md` is rendered with its ticket identity; the retargeted remote
 * copy had the number in its heading at best and never the UUIDs, so an agent told to "read your
 * issue and comment" had nothing to look it up by. The bridge pins the project and defaults
 * `get_issue` to this issue, so these ids are a convenience, not a requirement — but an agent
 * that can see them does not need to guess. Inserted straight after the `# Ticket #N: …` heading.
 */
export function announceRemoteAssignmentIdentity(
  markdown: string,
  ids: { projectId: string; issueId?: string | null },
): string {
  const heading = /^# .*$/m.exec(markdown);
  if (!heading) return markdown;
  const number = /^# Ticket #(\d+)/.exec(heading[0])?.[1];
  const lines = [
    "",
    "",
    "**Your assignment on the board** (the board tools default to these — you rarely need to pass them):",
    ...(number ? [`- issue number: #${number}`] : []),
    ...(ids.issueId ? [`- issue id: ${ids.issueId}`] : []),
    `- project id: ${ids.projectId}`,
  ];
  const at = heading.index + heading[0].length;
  return markdown.slice(0, at) + lines.join("\n") + markdown.slice(at);
}

/**
 * The context files a remote assignment ships, with the ticket brief ALWAYS among them (#1407).
 *
 * The brief reaches a launch only when its caller passes `contextFiles`. A relaunch with a
 * custom prompt (`Implement the ticket`) passes none — it re-writes `CLAUDE.local.md` into the
 * board worktree and relies on the agent finding it there — so a remote agent got a bare prompt
 * and no ticket at all. The file the board already wrote is therefore picked up from the
 * worktree itself, whatever the launch prompt or the caller.
 */
export function withTicketContextFile(
  contextFiles: string[] | undefined,
  worktreePath: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string[] | undefined {
  const files = contextFiles ?? [];
  if (files.some((p) => basename(p.replace(/\\/g, "/")) === TICKET_CONTEXT_FILENAME)) return contextFiles;
  if (!worktreePath) return contextFiles;
  const candidate = join(worktreePath, TICKET_CONTEXT_FILENAME);
  return exists(candidate) ? [...files, candidate] : contextFiles;
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
