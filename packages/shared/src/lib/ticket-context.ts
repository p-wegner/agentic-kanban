import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StackProfile } from "../types/api.js";
import { deriveVerifyCommandPlan } from "./verify-command.js";

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
  /**
   * Per-workspace Docker service stack, when the project declares one. Rendered so
   * the agent knows the sidecar services are already running (on which host ports,
   * and where the env vars live so it can source them) — or, when the stack FAILED
   * to come up (`status: "error"`), so the agent knows the declared services are NOT
   * available instead of burning the session debugging their absence.
   */
  serviceStack?: {
    /** "up" (default when omitted) renders the running-stack section; "error" a failure note. */
    status?: "up" | "error";
    /** Compose stderr / config error when status is "error". */
    error?: string | null;
    ports: Record<string, number>;
    envFilePath: string;
    composeProjectName: string;
    /**
     * Host the agent must use to reach the services — `localhost` when the board runs
     * on the host, `host.docker.internal` (DooD) or the `dind` sidecar name (DinD) when
     * the board itself runs in a container. Sourced from KANBAN_SERVICE_HOST (F2).
     */
    serviceHost: string;
    /**
     * Relative-path lint warnings found in the primary/sibling compose files (dev
     * #109/#162) — rendered regardless of `status` so an "up" stack that still carries
     * a directive that will misresolve is diagnosable, not just a hard failure.
     */
    lintWarnings?: string[] | null;
  } | null;
  /**
   * Where a builder should route a flaw it finds in the BOARD (as opposed to in the
   * project it is building). See {@link BoardFeedbackRouting}.
   */
  boardFeedback?: BoardFeedbackRouting | null;
};

/**
 * How board feedback leaves this machine. Which one applies is a property of how the
 * board is DEPLOYED, not a preference:
 *
 * - `file-ticket` — the board's own repo is registered as a project here, so there is a
 *   backlog to file into that the operator actually looks at. Normal for a git clone.
 * - `gh-issue` — there is no such project, so a ticket would have nowhere to live. This is
 *   the normal case for `npx agentic-kanban` and `docker run`: the board's code is a
 *   read-only package or image, nobody develops it on this machine, and a local ticket
 *   about board code would never be actioned. GitHub is where it reaches the maintainers.
 *
 * Note what is NOT offered in either case: editing the board's source. A builder lives in
 * a worktree of some other repo; for a packaged/containerized board there is no editable
 * checkout at all, and even for a clone the main checkout may be in use by other
 * workspaces. Fixing board code directly is a decision for the human's session, gated by
 * `CLAUDE.local.md` — see CLAUDE.md "Board Feedback Conventions".
 */
export type BoardFeedbackRouting =
  | { kind: "file-ticket"; projectId: string; projectName: string; isCurrentProject: boolean }
  | { kind: "gh-issue"; issuesUrl: string; deployment: "packaged" | "container" | "source-checkout" };

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

  // The canonical verify command + its running rules (#124). This is the command the merge
  // gate will run against this branch, so the builder must be told it verbatim — and told
  // how to run it, since the stack-specific traps (PowerShell native-stderr, raw XML reports)
  // are what turned the jvm-gradle cohort into the fleet's re-run outlier.
  const verify = deriveVerifyCommandPlan(profile);
  if (verify) {
    lines.push(
      "",
      "### Verify (the merge gate)",
      "",
      "Before you finish, run this EXACT command. It is the same command the board runs as",
      "the merge gate, so a green run here is what lets your work merge. Use it as-is —",
      "do not hand-roll your own build/test invocation, and do not add flags or pipes.",
      "",
      "```",
      verify.command,
      "```",
      "",
    );
    for (const rule of verify.rules) {
      lines.push(`- ${rule}`);
    }
    if (verify.onFailure) {
      lines.push(`- **When it fails:** ${verify.onFailure}`);
    }
  }
  return lines.join("\n");
}

/**
 * Render the service-stack section, or null when there is no stack. For a running
 * stack it tells the agent the sidecar services are already up, on which host ports,
 * and that the matching env vars are in `.kanban/services.env` (source it before
 * running app commands). For a FAILED stack it states explicitly that the declared
 * services are NOT running, with the failure reason — so the agent doesn't spend the
 * session failing integration tests against a missing database and guessing why.
 */
export function buildServiceStackSection(
  stack: TicketContext["serviceStack"],
): string | null {
  if (!stack) return null;
  if (stack.status === "error") {
    const lines = [
      "## Service stack — FAILED TO START",
      "",
      "This project declares a per-workspace Docker Compose service stack (sidecar",
      "services such as a database), but it FAILED to come up for this workspace.",
      "The declared services are **NOT running** — do not assume a database or other",
      "sidecar is available, and do not spend the session debugging their absence.",
      "",
      "Work on what does not require the services (unit tests, code changes) and state",
      "clearly in your final summary that the service stack was unavailable.",
    ];
    if (stack.error?.trim()) {
      lines.push("", "Failure reason:", "", "```", stack.error.trim(), "```");
    }
    appendLintWarnings(lines, stack.lintWarnings);
    return lines.join("\n");
  }
  // The "NOT necessarily localhost" warning is only true — and only useful — when the
  // board runs in a container (DooD/DinD) and the host really is something else. When the
  // host IS localhost it contradicts itself, so state the reach address plainly instead.
  const isLocalhost = stack.serviceHost === "localhost";
  const reachLines = isLocalhost
    ? [
        `Reach the services at **\`${stack.serviceHost}:<port>\`**. The connection host`,
        "`KANBAN_SERVICE_HOST` and the",
      ]
    : [
        `Reach the services at **\`${stack.serviceHost}:<port>\`** (NOT necessarily \`localhost\` —`,
        `the host is \`${stack.serviceHost}\`). The connection host \`KANBAN_SERVICE_HOST\` and the`,
      ];
  const lines = [
    "## Service stack",
    "",
    "This workspace has an isolated Docker Compose service stack that is ALREADY RUNNING",
    `(compose project \`${stack.composeProjectName}\`). Do not start it yourself.`,
    "",
    ...reachLines,
    "allocated `KANBAN_SVC_<NAME>_PORT` values are in `.kanban/services.env` (absolute path",
    "below). Source that file before running app/test commands that need the services,",
    "e.g. `set -a; . .kanban/services.env; set +a`.",
    "",
    `- **Service host:** \`${stack.serviceHost}\` (env \`KANBAN_SERVICE_HOST\`)`,
    `- **Env file:** \`${stack.envFilePath}\``,
  ];
  const portEntries = Object.entries(stack.ports);
  if (portEntries.length > 0) {
    lines.push("- **Allocated host ports:**");
    for (const [name, port] of portEntries) {
      lines.push(`  - \`${name}\` → \`${stack.serviceHost}:${port}\` (env \`KANBAN_SVC_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT\`)`);
    }
  }
  appendLintWarnings(lines, stack.lintWarnings);
  return lines.join("\n");
}

/**
 * Append compose relative-path lint warnings (dev #109/#162), if any, to a stack
 * section's line buffer. No-op when there is nothing to warn about, so a clean stack
 * stays exactly as before.
 */
function appendLintWarnings(lines: string[], lintWarnings: string[] | null | undefined): void {
  if (!lintWarnings || lintWarnings.length === 0) return;
  lines.push("", "**Compose lint warning(s):**", "");
  for (const w of lintWarnings) {
    lines.push("```", w, "```");
  }
}

/**
 * Filename written into the worktree root. Claude Code auto-loads `CLAUDE.local.md`
 * as project memory at session start. Other providers receive this file through
 * provider-specific launch wiring. The file is gitignored, so it never enters a
 * diff or merge.
 */
export const TICKET_CONTEXT_FILENAME = "CLAUDE.local.md";

/**
 * Render the "you found a bug in the BOARD" routing rule, or null when the board's own
 * project isn't registered (nothing actionable to point at — the agent should raise it
 * with the user instead of guessing a project).
 *
 * Why this ships in every worktree rather than living only in the board repo's CLAUDE.md:
 * a builder driving some OTHER project reads THAT project's CLAUDE.md, never the board's,
 * so the board's conventions reach it through exactly one channel — this file.
 */
export function buildBoardFeedbackSection(
  routing: TicketContext["boardFeedback"],
): string | null {
  if (!routing) return null;
  const lines = [
    "## If you hit a bug in the kanban board itself",
    "",
    "Distinct from a bug in the project you are building. You are in a WORKTREE, so the rule is",
    "fixed: **report it and keep going.** Do not try to fix the board's own code from here, and do",
    "not abandon your ticket over it.",
    "",
  ];
  if (routing.kind === "file-ticket") {
    if (routing.isCurrentProject) {
      lines.push(
        "This worktree IS the board's own repo, so file it against this same project:",
        "",
        "```",
        `create_issue({ projectId: "${routing.projectId}", title: "...", description: "..." })`,
        "```",
      );
    } else {
      lines.push(
        `The board's own project is **${routing.projectName}** — NOT the project you are building.`,
        "Pass `projectId` explicitly: `create_issue` defaults to the board's ACTIVE project, which is",
        "usually neither, and a misfiled ticket sits unactionable in the wrong backlog.",
        "",
        "```",
        `create_issue({ projectId: "${routing.projectId}", title: "...", description: "..." })`,
        "```",
      );
    }
  } else {
    const why =
      routing.deployment === "container"
        ? "This board runs from a container image"
        : routing.deployment === "packaged"
          ? "This board runs from an installed package (npx/npm), not a source checkout"
          : "This board's own repo is not registered as a project here";
    lines.push(
      `${why}, so there is`,
      "no board backlog on this machine to file into and no editable checkout to patch.",
      "Report it upstream instead:",
      "",
      `  ${routing.issuesUrl}`,
      "",
      "Do NOT file it as a ticket in the project you are building — that backlog is about that",
      "project, and a board bug there will never be actioned.",
    );
  }
  lines.push(
    "",
    "Write it up so it is actionable without your session: what you observed, the exact error,",
    "which file/command produced it, and what you expected instead.",
  );
  return lines.join("\n");
}

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
  const serviceSection = buildServiceStackSection(ctx.serviceStack);
  if (serviceSection) {
    lines.push(serviceSection);
    lines.push("");
  }
  if (ctx.contextPrimer?.trim()) {
    lines.push(ctx.contextPrimer.trim());
    lines.push("");
  }
  const boardFeedback = buildBoardFeedbackSection(ctx.boardFeedback);
  if (boardFeedback) {
    lines.push(boardFeedback);
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
