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
   * The verify command the merge gate will ACTUALLY run (#575).
   *
   * The gate reads the `verify_script_<projectId>` preference FIRST and only falls back
   * to the stack-profile derivation. Rendering the derived command unconditionally made
   * the file's own "this is the same command the board runs" promise false on every
   * project with an override — onboarding writes one, the projects route's AI generation
   * writes one, and operators edit it by hand. The builder then verified with command A
   * while the gate ran command B.
   *
   * Pass the resolved effective command (pref ?? derived); null/undefined falls back to
   * the derivation, which is correct when no override exists.
   */
  verifyCommandOverride?: string | null;
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
  /**
   * Ticket group (#661): the ADDITIONAL tickets this workspace serves beyond the lead
   * one above. When present, the file frames the work as one group — every ticket gets
   * its own full description section, the agent implements them one at a time with a
   * commit per ticket, and the board closes ALL of them when this one branch lands.
   */
  groupTickets?: Array<{ issueNumber: number | null; title: string; description?: string | null }> | null;
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
  | {
      kind: "gh-issue";
      issuesUrl: string;
      /**
       * `remote-worker` is not a board deployment at all — it is the WORKER's situation
       * (#749). A fleet worker runs the agent in its own checkout on another machine, with
       * no board MCP server configured and no route to the loopback board API, so
       * `create_issue` is not merely inconvenient there, it is impossible. Whatever the
       * board's own deployment is, a remote worktree must be told the reachable channel.
       */
      deployment: "packaged" | "container" | "source-checkout" | "remote-worker";
    };

/**
 * Render the stack profile's exact feedback commands as a markdown section, or null
 * when the profile carries nothing actionable. Driven-project builders otherwise guess
 * their build/test/dev commands; this hands them the detected ones up front.
 */
export function buildStackProfileSection(
  profile: StackProfile | null | undefined,
  verifyCommandOverride?: string | null,
): string | null {
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
  // #575: the OVERRIDE wins, because that is what the gate runs.
  const derived = deriveVerifyCommandPlan(profile);
  const overrideCommand = verifyCommandOverride?.trim();
  // Keep the derived plan's rules/onFailure guidance (the stack traps are still true —
  // the override only changes WHICH command runs), but render the command the gate uses.
  const verify = overrideCommand && derived
    ? { ...derived, command: overrideCommand }
    : derived;
  if (verify) {
    lines.push(
      "",
      "### Verify (the merge gate)",
      "",
      "Before you finish, run this EXACT command. It is the same command the board runs as",
      "the merge gate, so a green run here is what lets your work merge. Use it as-is —",
      "do not hand-roll your own build/test invocation, and do not add flags or pipes.",
      "",
      // Fenced defensively too: the verify command comes from the project's
      // `verify_script` preference, i.e. operator-supplied text, not a board constant.
      ...fencedBlock(verify.command),
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
      lines.push("", "Failure reason:", "", ...fencedBlock(stack.error.trim()));
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
    lines.push(...fencedBlock(w));
  }
}

/**
 * Fence a block of UNTRUSTED text so it cannot escape into the agent's instructions.
 *
 * This file is written to the worktree as `CLAUDE.local.md`, which Claude Code loads as
 * project memory — everything in it reads as instructions. The content fenced here is
 * external: docker/compose stderr and compose lint warnings, which routinely quote YAML
 * and file excerpts and can therefore contain a line of three backticks. With a
 * hardcoded ``` fence, that line CLOSED the block early and everything after it became
 * live instruction text in the agent's memory.
 *
 * The fix is CommonMark's own rule: an info-string-free fence may be closed only by a
 * run of at least as many backticks, so a fence LONGER than the longest backtick run in
 * the content cannot be closed from inside it. The content itself is never modified —
 * mangling a build error is how you make it undiagnosable — only the delimiter grows.
 */
export function fencedBlock(content: string): string[] {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return [fence, content, fence];
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
/**
 * Heading of the board-feedback section. Exported because it is a SEAM, not decoration:
 * {@link retargetTicketContextForRemoteWorker} rewrites the rendered file from this heading
 * onwards, and `ticket-context-remote-worker.test.ts` pins that the section is rendered
 * last so that truncation can never eat a section that came after it.
 */
export const BOARD_FEEDBACK_HEADING = "## If you hit a bug in the kanban board itself";

export function buildBoardFeedbackSection(
  routing: TicketContext["boardFeedback"],
): string | null {
  if (!routing) return null;
  const lines = [
    BOARD_FEEDBACK_HEADING,
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
      routing.deployment === "remote-worker"
        ? "You are running on a REMOTE FLEET WORKER — another machine, with no board MCP server and no route to the board's API"
        : routing.deployment === "container"
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
 * The "you are on a remote fleet worker" preamble to the board-feedback rule (#749).
 *
 * A builder dispatched to a fleet worker reads a ticket-context file the BOARD rendered, so
 * without this it is told to reflect progress and file findings through
 * `mcp__agentic-kanban__*` — tools that may not exist on that machine. The board's own
 * `--mcp-config` names a file in the board's tmpdir and is stripped, and the board API it
 * would talk to is bound to loopback by design.
 *
 * #769 made that conditional rather than absolute: when the fleet listener is up and the
 * provider has a config-file channel, the board ships a per-assignment MCP config pointed at
 * an ALLOWLISTED bridge, and the section is rewritten to name exactly the tools that work
 * (`boardTools`, applied later by {@link announceRemoteBoardTools}). With no bridge — no fleet
 * listener, or a codex/pi builder, which cannot be pointed at one from argv — the #749 text
 * stands unchanged: the board reads your OUTPUT, not your tool calls.
 */
export const REMOTE_WORKER_HEADING = "## You are running on a REMOTE FLEET WORKER";

export interface RemoteWorkerSectionOptions {
  /**
   * The board tools this worker CAN call, when the fleet MCP bridge is reachable for this
   * assignment (#769). Absent/empty = the #749 truth: no board tools at all.
   */
  boardTools?: readonly string[];
}

export function buildRemoteWorkerSection(opts: RemoteWorkerSectionOptions = {}): string {
  const tools = opts.boardTools ?? [];
  const toolBullet =
    tools.length > 0
      ? [
          "- **A NARROW set of board tools is available.** The board serves an allowlisted MCP bridge",
          "  for this one assignment, so exactly these tools work here and nothing else does:",
          "",
          ...tools.map((name) => `    - \`mcp__agentic-kanban__${name}\``),
          "",
          "  `create_issue` is PINNED to this assignment's project — you cannot misfile, and you do",
          "  not need to pass `projectId`. Every other board tool (merging, marking ready, moving",
          "  status, preferences, starting or deleting work) is REFUSED by the bridge: a refusal is",
          "  the expected answer, not a broken environment. Those decisions belong to the board.",
          "  There is still no route to the board's HTTP API from this machine.",
          "- **Progress still travels in your OUTPUT.** There is no comment tool on this bridge, so",
          "  anything you would have recorded as progress — findings, work you could not finish, why",
          "  you stopped — goes in your FINAL SUMMARY. That summary is what reaches the board.",
        ]
      : [
          "- **No board tools.** The `mcp__agentic-kanban__*` tools are NOT available here, and the",
          "  board's HTTP API is not reachable from this machine. Do not try to call them, and do not",
          "  treat their absence as a broken environment. Anything you would have recorded on the",
          "  board — progress, findings, follow-up work, a ticket you could not finish — goes in your",
          "  FINAL SUMMARY instead. That summary is what reaches the board.",
        ];
  return [
    REMOTE_WORKER_HEADING,
    "",
    "This checkout is NOT a board worktree — it is a clone on a different machine, made for",
    "this one assignment. Consequences you must plan around:",
    "",
    ...toolBullet,
    "- **Your work travels as commits.** Commit everything you want kept; the worker pushes your",
    "  branch back to the board when the session ends, and anything uncommitted is discarded",
    "  with this checkout.",
  ].join("\n");
}

/**
 * Rewrite an already-retargeted file to say that board tools ARE available (#769).
 *
 * A second pass rather than a parameter on {@link retargetTicketContextForRemoteWorker}, because
 * the two facts are known at different moments: the file is retargeted while the assignment is
 * being composed, and whether the MCP bridge can be offered depends on the fleet listener and on
 * the authority THIS worker dialed — resolved later, on the dispatch path.
 *
 * Section-delimited, like the board-feedback cut it sits above: the remote-worker section runs
 * from {@link REMOTE_WORKER_HEADING} to {@link BOARD_FEEDBACK_HEADING}, so replacing that span
 * leaves both neighbours untouched. A file without the heading is returned unchanged — never
 * appended to, since that would state both truths at once.
 *
 * The board-feedback section is deliberately NOT rewritten. `create_issue` is allowlisted, but
 * the retargeted file no longer carries the board's own project id (that is what the gh-issue
 * rewrite removed), and the bridge pins `create_issue` to the project being BUILT — so a board
 * bug still goes to the issues URL.
 */
export function announceRemoteBoardTools(markdown: string, opts: { boardTools: readonly string[] }): string {
  const start = markdown.indexOf(REMOTE_WORKER_HEADING);
  if (start === -1 || opts.boardTools.length === 0) return markdown;
  const feedbackAt = markdown.indexOf(BOARD_FEEDBACK_HEADING, start);
  const tail = feedbackAt === -1 ? "" : markdown.slice(feedbackAt);
  const head = markdown.slice(0, start);
  return [head + buildRemoteWorkerSection({ boardTools: opts.boardTools }), "", tail].join("\n");
}

/**
 * Retarget a rendered ticket-context file for a remote fleet worker's own checkout (#749).
 *
 * The board renders the file for ITS deployment — typically "file a ticket against the
 * board's project via `create_issue`", which is right for a board worktree and unfulfillable
 * on a worker. Rather than re-render (the caller has the file, not the `TicketContext` that
 * produced it), the board-feedback section is cut at its heading and replaced with the
 * remote-worker truth: no board tools, and board bugs go upstream.
 *
 * Safe because that section is rendered LAST — pinned by a test, so a future reordering
 * fails loudly instead of silently truncating a section that came after it. A file with no
 * such section (routing was null) just gets the remote sections appended.
 */
export function retargetTicketContextForRemoteWorker(
  markdown: string,
  opts: { issuesUrl: string },
): string {
  const cut = markdown.indexOf(BOARD_FEEDBACK_HEADING);
  const head = (cut === -1 ? markdown : markdown.slice(0, cut)).trimEnd();
  const feedback = buildBoardFeedbackSection({
    kind: "gh-issue",
    issuesUrl: opts.issuesUrl,
    deployment: "remote-worker",
  });
  return [head, "", buildRemoteWorkerSection(), "", feedback ?? "", ""].join("\n");
}

/**
 * Build the markdown body injected into the worktree as `CLAUDE.local.md`.
 * Frames the ticket as an authoritative reference doc so the agent treats it as
 * the source of truth instead of re-foraging the codebase for the same details.
 */
export function buildTicketContextMarkdown(ctx: TicketContext): string {
  const group = ctx.groupTickets?.filter(Boolean) ?? [];
  const groupRefs = group.map((t) => (t.issueNumber != null ? `#${t.issueNumber}` : `"${t.title}"`)).join(", ");
  const heading = ctx.issueNumber != null ? `Ticket #${ctx.issueNumber}: ${ctx.title}` : `Ticket: ${ctx.title}`;
  const lines = [
    "<!-- ak-ticket-context: auto-generated per workspace, gitignored, do not commit -->",
    `# ${heading}`,
    "",
    ...(group.length > 0
      ? [
          `This workspace serves a TICKET GROUP: this ticket plus ${group.length} more (${groupRefs}),`,
          "listed in full below. All of them are yours, on this one branch. Treat the details as the",
          "authoritative specification — do not re-read the codebase to rediscover what is stated here.",
        ]
      : [
          "This is the task you are working on. Treat the details below as the authoritative",
          "specification — do not re-read the codebase to rediscover what is already stated here.",
        ]),
    "",
    "## Description",
    "",
    ctx.description?.trim() ? ctx.description.trim() : "_(No description provided.)_",
    "",
  ];
  if (group.length > 0) {
    lines.push(
      "## Ticket group — the other tickets in this workspace",
      "",
      "Work through the group one ticket at a time, in any order that makes sense technically.",
      "Make a separate commit per ticket and reference its number (`#N`) in the commit message —",
      "commit granularity stays per ticket even though the branch, review, and merge gate are",
      "shared. When the branch merges, the board closes EVERY ticket in the group, so do not",
      "leave one silently unimplemented: if a ticket turns out to be infeasible or already done,",
      "say so explicitly in your final summary and in a comment on that ticket.",
      "",
    );
    for (const t of group) {
      lines.push(
        `### Ticket ${t.issueNumber != null ? `#${t.issueNumber}` : ""}: ${t.title}`.replace("Ticket :", "Ticket:"),
        "",
        t.description?.trim() ? t.description.trim() : "_(No description provided.)_",
        "",
      );
    }
  }
  const stackSection = buildStackProfileSection(ctx.stackProfile, ctx.verifyCommandOverride);
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
