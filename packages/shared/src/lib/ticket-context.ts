import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TicketContext = {
  issueNumber?: number | null;
  title: string;
  description?: string | null;
};

/**
 * Filename written into the worktree root. Claude Code auto-loads `CLAUDE.local.md`
 * as project memory at session start, so the ticket context lands in the agent's
 * first-turn context with zero agent action. The file is gitignored, so it never
 * enters a diff or merge.
 */
export const TICKET_CONTEXT_FILENAME = "CLAUDE.local.md";

/**
 * Build the markdown body injected into the worktree as `CLAUDE.local.md`.
 * Frames the ticket as an authoritative reference doc so the agent treats it as
 * the source of truth instead of re-foraging the codebase for the same details.
 */
export function buildTicketContextMarkdown(ctx: TicketContext): string {
  const heading = ctx.issueNumber != null ? `Ticket #${ctx.issueNumber}: ${ctx.title}` : `Ticket: ${ctx.title}`;
  const lines = [
    "<!-- ak-ticket-context: auto-generated per workspace, gitignored, do not commit -->",
    `# ${heading}`,
    "",
    "This is the task you are working on. Treat the details below as the authoritative",
    "specification — do not re-read the codebase to rediscover what is already stated here.",
    "",
    "## Description",
    "",
    ctx.description?.trim() ? ctx.description.trim() : "_(No description provided.)_",
    "",
  ];
  return lines.join("\n");
}

/**
 * Write the ticket context file into the worktree root. Best-effort: a write
 * failure must never block workspace creation, so callers should not let this throw.
 * Returns the absolute path written, or null on failure.
 */
export async function writeTicketContextFile(worktreePath: string, ctx: TicketContext): Promise<string | null> {
  const filePath = join(worktreePath, TICKET_CONTEXT_FILENAME);
  try {
    await writeFile(filePath, buildTicketContextMarkdown(ctx), "utf-8");
    return filePath;
  } catch {
    return null;
  }
}
