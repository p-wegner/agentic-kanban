import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StackProfile } from "../types/api.js";

export type TicketContext = {
  issueNumber?: number | null;
  title: string;
  description?: string | null;
  /** Optional context primer from the context-packer service. Appended after the description. */
  contextPrimer?: string | null;
  /**
   * Optional detected stack profile for the driven project. When present, its exact
   * build/test/dev commands are rendered so the agent runs the project's real feedback
   * commands from turn 1 instead of guessing them.
   */
  stackProfile?: StackProfile | null;
  /**
   * Multi-repo projects: the sibling worktrees created for the project's additional
   * repos (same branch as this worktree). Rendered so the agent knows it may edit
   * them and where they live.
   */
  additionalRepos?: Array<{ name: string | null; worktreePath: string }> | null;
};

/**
 * Render the stack profile's exact feedback commands as a markdown section, or null
 * when the profile carries nothing actionable. Driven-project builders otherwise guess
 * their build/test/dev commands; this hands them the detected ones up front.
 */
export function buildStackProfileSection(profile: StackProfile | null | undefined): string | null {
  if (!profile) return null;
  const rows: Array<[string, string | null]> = [
    ["Quick test (fast feedback)", profile.quickTestCommand],
    ["Full test", profile.testCommand],
    ["Build", profile.buildCommand],
    ["Typecheck", profile.typecheckCommand],
    ["Lint", profile.lintCommand],
    ["Dev server", profile.devCommand],
    ["Install deps", profile.installCommand],
  ];
  const present = rows.filter((r): r is [string, string] => Boolean(r[1]?.trim()));
  if (present.length === 0) return null;

  const lines = [
    "## Stack & Feedback Commands",
    "",
    "This project's stack was auto-detected. Run THESE exact commands for build/test/dev",
    "feedback — do not invent or guess commands for another stack.",
    "",
  ];
  const meta: string[] = [];
  if (profile.stack) meta.push(`**Stack:** ${profile.stack}`);
  if (profile.packageManager) meta.push(`**Package manager:** ${profile.packageManager}`);
  if (profile.isMonorepo) meta.push("**Monorepo:** yes");
  if (meta.length) {
    lines.push(meta.join(" · "), "");
  }
  for (const [label, cmd] of present) {
    lines.push(`- **${label}:** \`${cmd}\``);
  }
  if (profile.isWeb && profile.devHealthUrl) {
    lines.push(`- **Dev health URL:** ${profile.devHealthUrl}`);
  }
  return lines.join("\n");
}

/**
 * Filename written into the worktree root. Claude Code auto-loads `CLAUDE.local.md`
 * as project memory at session start. Other providers receive this file through
 * provider-specific launch wiring. The file is gitignored, so it never enters a
 * diff or merge.
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
  const stackSection = buildStackProfileSection(ctx.stackProfile);
  if (stackSection) {
    lines.push(stackSection);
    lines.push("");
  }
  if (ctx.additionalRepos && ctx.additionalRepos.length > 0) {
    lines.push(
      "## Additional repositories",
      "",
      "This is a multi-repo project. Each repo below has a worktree checked out on the",
      "SAME branch as this one — you may read and edit files there when the task requires",
      "it; commits you make there are diffed, reviewed, and merged together with this repo.",
      "",
    );
    for (const repo of ctx.additionalRepos) {
      lines.push(`- ${repo.name ? `**${repo.name}**: ` : ""}\`${repo.worktreePath}\``);
    }
    lines.push("");
  }
  if (ctx.contextPrimer?.trim()) {
    lines.push(ctx.contextPrimer.trim());
    lines.push("");
  }
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
