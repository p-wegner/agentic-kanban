import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSessionSummary, isTerminalStatusName } from "@agentic-kanban/shared";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { isAnalyticsNoise } from "../../services/session-filter.js";
import { getWorkspaceDiffStats, type WorkspaceDiffStats } from "../../services/workspace-diff-stats.js";
import {
  getIssueListForProject,
  getIssueHeaderByNumber,
  getIssueByNumberOrId,
  getIssueIdByNumberInProject,
  createIssueWithNextNumber,
  moveIssueToStatus,
  createSubIssueWithParentLink,
  getIssuesTouchedFilesByNumbers,
} from "../../repositories/issue.repository.js";
import {
  updateIssueById,
  insertIssueArtifact,
  deleteIssueCascade,
  createIssuesBatchWithDepsAndTags,
} from "../../repositories/issue-service.repository.js";
import { isIssueNumberUniqueConstraintError, nextIssueNumber } from "../../repositories/issue-number.repository.js";
import { getProjectStatuses, getProjectById } from "../../repositories/project.repository.js";
import { getWorkspacesByIssueId, findOpenUnmergedWorkspace } from "../../repositories/workspace.repository.js";
import { getSessionsForWorkspacesDesc } from "../../repositories/workspace-launch-failures.repository.js";
import { getSessionMessagesByIdDesc, getSessionMessagesByIdAsc } from "../../repositories/session.repository.js";
import { getWorkspaceArtifactTarget } from "../../repositories/phase-artifacts.repository.js";
import { buildIssueSummaryLines, buildIssueStatusLines, validateAttachArtifactOptions, formatAttachArtifactOutput, selectSummarySession, buildIssueSummaryJson, buildIssueStatusJson } from "../../lib/issue-cli-format.js";
import { computeSessionDuration } from "../../lib/issue-summary-projection.js";
import { extractLastAgentMessageFromRows } from "../../lib/session-message-extraction.js";
import { openWorkspaceBlockMessage } from "../../lib/terminal-move-guard.js";
import { registerIssueDependencyCommands } from "./issue-dependency.js";
import { normalizeBatchInput, validateBatchIssueInputs, formatBatchCreateResult } from "../../lib/batch-create-issues.js";

const ISSUE_NUMBER_INSERT_ATTEMPTS = 3;

export function registerIssueCommand(program: Command) {
  const issueCmd = program.command("issue").description("Manage issues on the board.\n\nSubcommands: list, create, update, move, summary, dependency");

  issueCmd
    .command("list")
    .description("List issues for the active project.\n\nShows issue number, priority, status, and title. Filters can be combined.")
    .option("-s, --status <status>", "Filter by status name (e.g. Todo, 'In Progress', Done)")
    .option("-p, --priority <priority>", "Filter by priority (low, medium, high, critical)")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue list                        # all issues
  $ agentic-kanban issue list -s Todo                # only todo issues
  $ agentic-kanban issue list -p critical            # only critical priority
  $ agentic-kanban issue list -s "In Progress" -p high
  $ agentic-kanban issue list --json                 # machine-readable output
`)
    .action(async (options: { status?: string; priority?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        let rows = await getIssueListForProject(projectId);

        if (options.status) rows = rows.filter((r) => r.statusName === options.status);
        if (options.priority) rows = rows.filter((r) => r.priority === options.priority);

        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
          process.exit(0);
        }

        if (rows.length === 0) {
          console.log("No issues found.");
          process.exit(0);
        }

        for (const r of rows) {
          const num = r.issueNumber != null ? `#${r.issueNumber}` : "(no number)";
          console.log(`  ${num.padEnd(6)} [${(r.issueType ?? "task").padEnd(8)}] [${r.statusName}] ${r.title}`);
          console.log(`         id: ${r.id}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("get <issue-number>")
    .description("Show full details of an issue by its number.\n\nDisplays title, description, priority, status, and workspace info for an issue in the active project.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue get 42
  $ agentic-kanban issue get 42 --json
`)
    .action(async (issueNumberArg: string, options: { json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const num = Number(issueNumberArg);
        if (!Number.isInteger(num) || num <= 0) {
          console.error(`Invalid issue number: ${issueNumberArg}`);
          process.exit(1);
        }

        const issue = await getIssueHeaderByNumber(projectId, num);

        if (!issue) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(issue, null, 2));
          process.exit(0);
        }

        console.log(`\n  #${issue.issueNumber} ${issue.title}`);
        console.log(`  Status:   ${issue.statusName}`);
        console.log(`  Type:     ${issue.issueType ?? "task"}`);
        console.log(`  Priority: ${issue.priority}`);
        console.log(`  ID:       ${issue.id}`);
        if (issue.description) {
          console.log(`\n  Description:`);
          for (const line of issue.description.split("\n")) {
            console.log(`    ${line}`);
          }
        } else {
          console.log(`\n  Description: (none)`);
        }
        console.log("");
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("create <title>")
    .description("Create a new issue in the active project.\n\nIssue numbers are auto-incrementing per project. The issue is placed in the first project status (typically Todo) unless overridden with -s.")
    .option("-d, --description <description>", "Issue description (markdown supported)")
    .option("-p, --priority <priority>", "Priority: low, medium, high, critical (default: medium)")
    .option("-t, --type <type>", "Issue type: task, bug, feature, chore (default: task)")
    .option("-s, --status <status>", "Initial status name (default: first project status, typically Todo)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue create "Fix login bug" -t bug
  $ agentic-kanban issue create "Add dark mode" -d "Support theme switching" -t feature
  $ agentic-kanban issue create "Hotfix" -t bug -s "In Progress"
`)
    .action(async (title: string, options: { description?: string; priority?: string; type?: string; status?: string }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const statuses = await getProjectStatuses(projectId);

        if (statuses.length === 0) throw new Error("No statuses found for project.");

        let statusId = statuses[0].id;
        if (options.status) {
          const found = statuses.find((s) => s.name === options.status);
          if (!found) {
            console.error(`Status '${options.status}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
            process.exit(1);
          }
          statusId = found.id;
        }

        const { id, issueNumber } = await createIssueWithNextNumber({
          projectId,
          statusId,
          title,
          description: options.description,
          priority: options.priority,
          issueType: options.type,
        });

        console.log(`Created issue #${issueNumber}: ${title}`);
        console.log(`  id: ${id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("update <issue>")
    .description("Update an existing issue's fields.\n\nAccepts an issue number (resolved in the active project) or a full issue ID. Only the flags you pass are changed; every other field is left untouched. Use --description-file to set a multi-line / markdown description from a file — this avoids shell quoting and newline mangling that can truncate an inline -d value.")
    .option("--title <title>", "New title")
    .option("-d, --description <description>", "New description (markdown supported)")
    .option("--description-file <path>", "Read the new description from a UTF-8 file (overrides -d)")
    .option("-p, --priority <priority>", "Priority: low, medium, high, critical")
    .option("-t, --type <type>", "Issue type: task, bug, feature, chore")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue update 42 --title "Clearer title"
  $ agentic-kanban issue update 42 -p high -t bug
  $ agentic-kanban issue update 42 --description-file ./desc.md
  $ agentic-kanban issue update 42 -d "Short inline description"

Tip: to change an issue's STATUS, use 'issue move' instead.
`)
    .action(async (issueArg: string, options: { title?: string; description?: string; descriptionFile?: string; priority?: string; type?: string }) => {
      try {
        await runMigrations();

        // Resolve by issue number (active project) or by full ID, like 'issue move'.
        const isNumeric = /^\d+$/.test(issueArg);
        const projectId = isNumeric ? await getActiveProjectId() : undefined;

        const issue = await getIssueByNumberOrId(issueArg, projectId);
        if (!issue) {
          console.error(`Issue '${issueArg}' not found.`);
          process.exit(1);
        }

        // Build the update set from provided flags only — untouched flags stay as-is.
        const updates: Record<string, unknown> = {};

        if (options.title !== undefined) {
          const title = options.title.trim();
          if (!title) {
            console.error("Title cannot be empty.");
            process.exit(1);
          }
          updates.title = title;
        }

        let description = options.description;
        if (options.descriptionFile !== undefined) {
          try {
            description = readFileSync(options.descriptionFile, "utf8");
          } catch (err) {
            console.error(`Could not read description file '${options.descriptionFile}': ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        }
        if (description !== undefined) updates.description = description;

        if (options.priority !== undefined) {
          const validPriorities = ["low", "medium", "high", "critical"];
          if (!validPriorities.includes(options.priority)) {
            console.error(`Invalid priority '${options.priority}'. Valid: ${validPriorities.join(", ")}`);
            process.exit(1);
          }
          updates.priority = options.priority;
        }

        if (options.type !== undefined) {
          const validTypes = ["task", "bug", "feature", "chore"];
          if (!validTypes.includes(options.type)) {
            console.error(`Invalid type '${options.type}'. Valid: ${validTypes.join(", ")}`);
            process.exit(1);
          }
          updates.issueType = options.type;
        }

        if (Object.keys(updates).length === 0) {
          console.error("Nothing to update. Pass at least one of --title, -d/--description, --description-file, -p/--priority, -t/--type.");
          process.exit(1);
        }

        updates.updatedAt = new Date().toISOString();
        await updateIssueById(issue.id, updates);

        const changed = Object.keys(updates).filter((k) => k !== "updatedAt");
        const num = issue.issueNumber != null ? `#${issue.issueNumber}` : issue.id;
        console.log(`Updated issue ${num} (${changed.join(", ")}).`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("move <issue-id> <status>")
    .description("Move an issue to a different status.\n\nThe status name must match one of the project's configured statuses exactly (case-sensitive). Use 'issue list' to see available status names.")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue move abc123 "In Progress"
  $ agentic-kanban issue move abc123 Done

Tip: Use 'issue list' to find the issue ID and see available status names.
`)
    .action(async (issueId: string, statusName: string) => {
      try {
        await runMigrations();

        const isNumeric = /^\d+$/.test(issueId);
        const projectId = isNumeric ? await getActiveProjectId() : undefined;

        const issue = await getIssueByNumberOrId(issueId, projectId);
        if (!issue) {
          console.error(`Issue '${issueId}' not found.`);
          process.exit(1);
        }

        const statuses = await getProjectStatuses(issue.projectId);
        const target = statuses.find((s) => s.name === statusName);
        if (!target) {
          console.error(`Status '${statusName}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
          process.exit(1);
        }

        // AK-535 guard: don't strand an open, non-direct, unmerged branch by moving
        // the issue to a terminal status. Same guard as the server PATCH route and MCP.
        if (isTerminalStatusName(statusName)) {
          const openWs = await findOpenUnmergedWorkspace(issue.id);
          if (openWs) {
            console.error(openWorkspaceBlockMessage(statusName, openWs.branch));
            process.exit(1);
          }
        }

        await moveIssueToStatus(issue.id, target.id);

        console.log(`Moved issue to '${statusName}'`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("status <issue-number>")
    .description("Quick status check for an issue: workspace state, session info, and last agent message.\n\nResolves issue number to workspace(s) → latest session → last agent output. Useful for checking what an agent is doing or what it last said.")
    .option("--json", "Output raw JSON")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue status 17
  $ agentic-kanban issue status 17 --json
`)
    .action(async (issueNumberArg: string, options: { json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const num = Number(issueNumberArg);
        if (!Number.isInteger(num) || num <= 0) {
          console.error(`Invalid issue number: ${issueNumberArg}`);
          process.exit(1);
        }

        const issue = await getIssueHeaderByNumber(projectId, num);

        if (!issue) {
          console.error(`Issue #${num} not found.`);
          process.exit(1);
        }

        const project = await getProjectById(projectId);
        const projectDefaultBranch = project?.defaultBranch ?? null;

        const wsRows = await getWorkspacesByIssueId(issue.id);

        if (wsRows.length === 0) {
          console.log(`#${num} ${issue.title}`);
          console.log(`  Status: ${issue.statusName} · Type: ${issue.issueType ?? "task"}`);
          console.log("  No workspace.");
          process.exit(0);
        }

        const wsIds = wsRows.map(w => w.id);
        const sessionRows = await getSessionsForWorkspacesDesc(wsIds);

        const latestSession = sessionRows.find(s => !isAnalyticsNoise(s)) ?? sessionRows[0] ?? null;
        const matchingWs = latestSession ? wsRows.find(w => w.id === latestSession.workspaceId) : wsRows[0];

        let lastAgentMsg: string | null = null;
        let fileChanges: { read: number; edited: number; written: number } | null = null;
        let diffStats: WorkspaceDiffStats | null = null;

        if (matchingWs) {
          diffStats = await getWorkspaceDiffStats(matchingWs, projectDefaultBranch);
        }

        if (latestSession) {
          const msgRows = await getSessionMessagesByIdDesc(latestSession.id);

          lastAgentMsg = extractLastAgentMessageFromRows(msgRows);

          const summary = parseSessionSummary(msgRows);
          fileChanges = { read: summary.filesRead.length, edited: summary.filesEdited.length, written: summary.filesWritten.length };
        }

        if (options.json) {
          console.log(JSON.stringify(buildIssueStatusJson({
            issueNumber: issue.issueNumber,
            title: issue.title,
            statusName: issue.statusName,
            priority: issue.priority,
            workspace: matchingWs ?? null,
            session: latestSession,
            lastAgentMessage: lastAgentMsg,
            fileChanges,
            diffStats,
          }), null, 2));
          process.exit(0);
        }

        for (const line of buildIssueStatusLines({
          num,
          title: issue.title,
          statusName: issue.statusName,
          issueType: issue.issueType,
          workspace: matchingWs ?? null,
          session: latestSession,
          diffStats,
          fileChanges,
          lastAgentMessage: lastAgentMsg,
          nowMs: Date.now(),
        })) {
          console.log(line);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("summary <issue-number>")
    .description("Show a summary of the latest completed agent session for an issue.\n\nResolves issue number to workspace and session, then prints agent summary text, files touched, duration, and cost. Useful for quickly reviewing what an agent did.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue summary 1          # formatted summary
  $ agentic-kanban issue summary 5 --json   # machine-readable JSON
`)
    .action(async (issueNumber: string, options: { json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const num = Number(issueNumber);
        if (!Number.isInteger(num) || num <= 0) {
          console.error(`Invalid issue number: ${issueNumber}`);
          process.exit(1);
        }

        const issue = await getIssueByNumberOrId(String(num), projectId);

        if (!issue) {
          console.error(`Issue #${num} not found.`);
          process.exit(1);
        }

        const wsRows = await getWorkspacesByIssueId(issue.id);

        if (wsRows.length === 0) {
          console.log(`#${num} ${issue.title}`);
          console.log("  No workspace found for this issue.");
          process.exit(0);
        }

        const wsIds = wsRows.map(w => w.id);
        const sessionRows = await getSessionsForWorkspacesDesc(wsIds);

        const completedSession = selectSummarySession(sessionRows, isAnalyticsNoise);

        if (!completedSession) {
          console.log(`#${num} ${issue.title}`);
          console.log("  No session found for this issue.");
          process.exit(0);
        }

        const msgRows = await getSessionMessagesByIdAsc(completedSession.id);

        let stats: Record<string, unknown> | null = null;
        if (completedSession.stats) {
          try { stats = JSON.parse(completedSession.stats) as Record<string, unknown>; } catch { /* ignore */ }
        }

        const duration = computeSessionDuration(completedSession.startedAt, completedSession.endedAt);

        const summary = parseSessionSummary(msgRows);
        if (!summary.agentSummary && stats && typeof stats.agentSummary === "string") {
          summary.agentSummary = stats.agentSummary;
        }

        const matchingWorkspace = wsRows.find(w => w.id === completedSession.workspaceId);

        if (options.json) {
          console.log(JSON.stringify(buildIssueSummaryJson({
            issueId: issue.id,
            issueNumber: issue.issueNumber,
            title: issue.title,
            workspace: matchingWorkspace ?? null,
            session: completedSession,
            duration,
            stats,
            summary,
          }), null, 2));
          process.exit(0);
        }

        for (const line of buildIssueSummaryLines({
          num,
          title: issue.title,
          workspace: matchingWorkspace ?? null,
          sessionStatus: completedSession.status,
          duration,
          stats,
          summary,
        })) {
          console.log(line);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  registerIssueDependencyCommands(issueCmd);

  issueCmd
    .command("create-sub <parent-number> <title>")
    .description("Create a child issue linked to a parent with a child_of dependency.\n\nThe child issue is created in the same project as the parent and linked via a child_of dependency in the same transaction.")
    .option("-d, --description <description>", "Child issue description")
    .option("-p, --priority <priority>", "Priority: low, medium, high, critical (default: medium)")
    .option("-t, --type <type>", "Issue type: task, bug, feature, chore (default: task)")
    .option("-s, --status <status>", "Status name for the new child issue (default: first project status)")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue create-sub 10 "Sub-task: write tests"
  $ agentic-kanban issue create-sub 10 "Fix edge case" -t bug -p high
  $ agentic-kanban issue create-sub 10 "Design UI" --status "In Progress" --json
`)
    .action(async (parentNumberArg: string, title: string, options: { description?: string; priority?: string; type?: string; status?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        if (!title.trim()) {
          console.error("Title cannot be empty.");
          process.exit(1);
        }

        const parentNum = Number(parentNumberArg);
        if (!Number.isInteger(parentNum) || parentNum <= 0) {
          console.error(`Invalid parent issue number: ${parentNumberArg}`);
          process.exit(1);
        }

        const parent = await getIssueByNumberOrId(String(parentNum), projectId);

        if (!parent) {
          console.error(`Parent issue #${parentNum} not found in active project.`);
          process.exit(1);
        }

        const statuses = await getProjectStatuses(parent.projectId);

        if (statuses.length === 0) {
          console.error("No statuses configured for project.");
          process.exit(1);
        }

        let statusId = statuses[0].id;
        if (options.status) {
          const found = statuses.find((s) => s.name === options.status);
          if (!found) {
            console.error(`Status '${options.status}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
            process.exit(1);
          }
          statusId = found.id;
        }

        const { id, issueNumber, dependencyId } = await createSubIssueWithParentLink({
          projectId: parent.projectId,
          parentId: parent.id,
          title,
          description: options.description,
          priority: options.priority,
          issueType: options.type,
          statusId,
        });

        const result = {
          id,
          issueNumber,
          title,
          parentIssueId: parent.id,
          parentIssueNumber: parent.issueNumber,
          dependencyId,
          dependencyType: "child_of",
          statusId,
          priority: options.priority ?? "medium",
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Created child issue #${issueNumber}: ${title}`);
          console.log(`  id: ${id}`);
          console.log(`  parent: #${parent.issueNumber} (${parent.title})`);
          console.log(`  dependency: ${dependencyId} (child_of)`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("delete <issue-number>")
    .description("Delete an issue and all its associated data.\n\nCascade-deletes workspaces, sessions, messages, tags, and artifacts. This cannot be undone. Pass --force to skip the confirmation note.")
    .option("--force", "Skip the confirmation warning (for scripting)")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue delete 42             # prompts about permanence
  $ agentic-kanban issue delete 42 --force     # no warning output
  $ agentic-kanban issue delete 42 --json

Note: deletion is permanent. There is no undo. The issue number will not be reused.
`)
    .action(async (issueNumberArg: string, options: { force?: boolean; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const num = Number(issueNumberArg);
        if (!Number.isInteger(num) || num <= 0) {
          console.error(`Invalid issue number: ${issueNumberArg}`);
          process.exit(1);
        }

        const issue = await getIssueByNumberOrId(String(num), projectId);

        if (!issue) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        if (!options.force) {
          console.log(`Warning: This will permanently delete issue #${num} "${issue.title}" and ALL associated workspaces, sessions, and messages. Use --force to suppress this message.`);
        }

        // Cascade workspaces (+ their sessions/messages/comments/artifacts) → tags → issue.
        await deleteIssueCascade(issue.id);

        const result = { id: issue.id, issueNumber: num, title: issue.title, deleted: true };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Deleted issue #${num}: ${issue.title}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("attach-artifact <issue-number>")
    .description("Attach a text, link, or image artifact to an issue.\n\nArtifacts are visible in the issue detail panel. Use --workspace to additionally associate the artifact with a specific workspace.")
    .option("--type <type>", "Artifact type: text, link, or image (required)")
    .option("--content <content>", "Text content, URL, or base64/data URL image content (required)")
    .option("--mime-type <mimeType>", "Optional MIME type, e.g. text/markdown or image/png")
    .option("--caption <caption>", "Optional short caption")
    .option("--workspace <workspaceId>", "Optional workspace ID to associate the artifact with")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue attach-artifact 42 --type link --content "https://example.com/docs" --caption "Design doc"
  $ agentic-kanban issue attach-artifact 42 --type text --content "# Notes" --mime-type text/markdown
  $ agentic-kanban issue attach-artifact 42 --type image --content "data:image/png;base64,..." --caption "Screenshot"

Valid types: text, link, image
`)
    .action(async (issueNumberArg: string, options: { type?: string; content?: string; mimeType?: string; caption?: string; workspace?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const validated = validateAttachArtifactOptions(issueNumberArg, options);
        if (!validated.ok) {
          console.error(validated.error);
          process.exit(1);
        }
        const { num, type, content } = validated;

        const issueId = await getIssueIdByNumberInProject(num, projectId);

        if (!issueId) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        if (options.workspace) {
          const target = await getWorkspaceArtifactTarget(options.workspace, issueId);
          if (!target) {
            console.error(`Workspace '${options.workspace}' not found or does not belong to issue #${num}.`);
            process.exit(1);
          }
        }

        const id = randomUUID();
        await insertIssueArtifact({
          id,
          issueId,
          workspaceId: options.workspace ?? null,
          type,
          mimeType: options.mimeType ?? null,
          content,
          caption: options.caption ?? null,
        });

        const result = {
          id,
          issueId,
          workspaceId: options.workspace ?? null,
          type,
          mimeType: options.mimeType ?? null,
          caption: options.caption ?? null,
        };

        for (const line of formatAttachArtifactOutput(result, num, options.json ?? false)) {
          console.log(line);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("create-batch <jsonFile>")
    .description("Create multiple issues atomically from a JSON file.\n\nReads a JSON file containing an array of issue payloads and creates them all in a single transaction, optionally with dependency edges between them. All-or-nothing: any failure rolls back.")
    .option("--parent <issueNumber>", "Parent issue number — all created issues will be linked to it with child_of")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue create-batch issues.json
  $ agentic-kanban issue create-batch issues.json --parent 10
  $ agentic-kanban issue create-batch issues.json --json

JSON file format:
  {
    "issues": [
      { "title": "Task one", "priority": "high", "issueType": "task" },
      { "title": "Task two", "description": "Details...", "statusName": "In Progress" }
    ],
    "dependencies": [
      { "issueIndex": 1, "dependsOnIndex": 0, "type": "depends_on" }
    ]
  }

Each issue: title (required), description, priority, issueType, estimate, sortOrder, statusName, tags
Each dependency: issueIndex, dependsOnIndex (0-based indices), type (optional, default: depends_on)
`)
    .action(async (jsonFile: string, options: { parent?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        let fileContent: string;
        try {
          fileContent = readFileSync(jsonFile, "utf8");
        } catch (err) {
          console.error(`Could not read file '${jsonFile}': ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(fileContent);
        } catch {
          console.error("Invalid JSON in file.");
          process.exit(1);
        }

        const normalized = normalizeBatchInput(parsed);
        if (!normalized.ok) {
          console.error(normalized.error);
          process.exit(1);
        }
        const { issueInputs, dependencyInputs } = normalized;

        const statuses = await getProjectStatuses(projectId);

        if (statuses.length === 0) {
          console.error("No statuses configured for project.");
          process.exit(1);
        }

        const validationError = validateBatchIssueInputs(issueInputs, statuses.map((s) => s.name));
        if (validationError) {
          console.error(validationError);
          process.exit(1);
        }

        let parentIssueId: string | undefined;
        if (options.parent) {
          const parentNum = Number(options.parent);
          if (!Number.isInteger(parentNum) || parentNum <= 0) {
            console.error(`Invalid parent issue number: ${options.parent}`);
            process.exit(1);
          }
          const resolvedParentId = await getIssueIdByNumberInProject(parentNum, projectId);
          if (!resolvedParentId) {
            console.error(`Parent issue #${parentNum} not found in active project.`);
            process.exit(1);
          }
          parentIssueId = resolvedParentId;
        }

        const now = new Date().toISOString();

        let created: Array<{ id: string; issueNumber: number; title: string }> | null = null;
        for (let attempt = 1; attempt <= ISSUE_NUMBER_INSERT_ATTEMPTS; attempt++) {
          const nextNumber = await nextIssueNumber(projectId);
          try {
            ({ created } = await createIssuesBatchWithDepsAndTags({
              projectId,
              startNumber: nextNumber,
              now,
              issueInputs,
              dependencyInputs,
              statuses,
              parentIssueId,
            }));
            break;
          } catch (err: unknown) {
            if (attempt < ISSUE_NUMBER_INSERT_ATTEMPTS && isIssueNumberUniqueConstraintError(err)) {
              continue;
            }
            throw err;
          }
        }

        if (created === null) {
          throw new Error("Could not allocate unique issue numbers");
        }

        for (const line of formatBatchCreateResult(created, dependencyInputs.length, options.json ?? false)) {
          console.log(line);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  issueCmd
    .command("check-overlap <issueNumbers...>")
    .description("Check which files overlap between a set of issues based on their cached touched-file predictions.\n\nReturns a map of filePath → [issueNumbers] for files touched by more than one issue. Run analyze_touched_files on each issue first to populate the cache.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue check-overlap 10 11 12
  $ agentic-kanban issue check-overlap 10 11 --json

Note: run 'analyze_touched_files' (via MCP) on each issue first to populate the prediction cache.
At least 2 issue numbers are required.
`)
    .action(async (issueNumberArgs: string[], options: { json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        if (issueNumberArgs.length < 2) {
          console.error("At least 2 issue numbers are required.");
          process.exit(1);
        }

        const nums = issueNumberArgs.map((a) => Number(a));
        for (const n of nums) {
          if (!Number.isInteger(n) || n <= 0) {
            console.error(`Invalid issue number: ${n}`);
            process.exit(1);
          }
        }

        const issueRows = await getIssuesTouchedFilesByNumbers(projectId, nums);

        const foundNums = new Set(issueRows.map((r) => r.issueNumber));
        for (const n of nums) {
          if (!foundNums.has(n)) {
            console.error(`Issue #${n} not found in active project.`);
            process.exit(1);
          }
        }

        const overlap: Record<string, number[]> = {};
        for (const row of issueRows) {
          if (!row.touchedFilesJson) continue;
          let files: { path: string }[];
          try { files = JSON.parse(row.touchedFilesJson) as { path: string }[]; } catch { continue; }
          for (const f of files) {
            if (!f.path) continue;
            if (!overlap[f.path]) overlap[f.path] = [];
            if (row.issueNumber != null && !overlap[f.path].includes(row.issueNumber)) overlap[f.path].push(row.issueNumber);
          }
        }
        for (const path of Object.keys(overlap)) {
          if (overlap[path].length < 2) delete overlap[path];
        }

        const issuesWithoutCache = issueRows.filter((r) => !r.touchedFilesJson).map((r) => r.issueNumber);

        const result: { overlap: Record<string, number[]>; warning?: string } = { overlap };
        if (issuesWithoutCache.length > 0) {
          result.warning = `${issuesWithoutCache.length} issue(s) have no cached prediction yet: #${issuesWithoutCache.join(", #")}`;
        }

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const paths = Object.keys(overlap);
          if (paths.length === 0) {
            console.log("No file overlaps detected.");
          } else {
            console.log(`File overlaps (${paths.length} file(s)):`);
            for (const p of paths) {
              console.log(`  ${p}: issues #${overlap[p].join(", #")}`);
            }
          }
          if (result.warning) {
            console.log(`Warning: ${result.warning}`);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

