import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projectStatuses, workspaces, sessions, sessionMessages, issueDependencies, DEPENDENCY_TYPES, projects, diffComments, issueArtifacts, issueTags, tags } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSessionSummary, formatDurationStr } from "@agentic-kanban/shared";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { isAnalyticsNoise } from "../../services/session-filter.js";
import { getWorkspaceDiffStats, type WorkspaceDiffStats } from "../../services/workspace-diff-stats.js";
import { hasPath } from "../../lib/dependency-graph.js";
import { getIssueIdsAndProjectsForBatch, getDependencyRowsForProjects } from "../../repositories/issue-service.repository.js";
import { buildIssueSummaryLines } from "../../lib/issue-cli-format.js";

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

        let rows = await db
          .select({
            issueNumber: issues.issueNumber,
            id: issues.id,
            title: issues.title,
            priority: issues.priority,
            issueType: issues.issueType,
            statusName: projectStatuses.name,
            createdAt: issues.createdAt,
          })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(eq(issues.projectId, projectId));

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

        const issueRows = await db
          .select({
            id: issues.id,
            issueNumber: issues.issueNumber,
            title: issues.title,
            description: issues.description,
            priority: issues.priority,
            issueType: issues.issueType,
            statusName: projectStatuses.name,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
          .limit(1);

        if (issueRows.length === 0) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        const issue = issueRows[0];

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

        const statuses = await db
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, projectId))
          .orderBy(projectStatuses.sortOrder);

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

        const maxResult = await db
          .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
          .from(issues)
          .where(eq(issues.projectId, projectId));
        const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

        const id = randomUUID();
        const now = new Date().toISOString();

        await db.insert(issues).values({
          id,
          issueNumber,
          title,
          description: options.description ?? null,
          priority: (options.priority as "low" | "medium" | "high" | "critical") ?? "medium",
          issueType: (options.type as "task" | "bug" | "feature" | "chore") ?? "task",
          sortOrder: 0,
          statusId,
          projectId,
          createdAt: now,
          updatedAt: now,
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
        const whereClause = isNumeric
          ? and(eq(issues.issueNumber, Number(issueArg)), eq(issues.projectId, projectId!))
          : eq(issues.id, issueArg);

        const issueRows = await db.select().from(issues).where(whereClause).limit(1);
        if (issueRows.length === 0) {
          console.error(`Issue '${issueArg}' not found.`);
          process.exit(1);
        }
        const issue = issueRows[0];

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
        await db.update(issues).set(updates).where(eq(issues.id, issue.id));

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
        const whereClause = isNumeric
          ? and(eq(issues.issueNumber, Number(issueId)), eq(issues.projectId, projectId!))
          : eq(issues.id, issueId);

        const issueRows = await db.select().from(issues).where(whereClause).limit(1);
        if (issueRows.length === 0) {
          console.error(`Issue '${issueId}' not found.`);
          process.exit(1);
        }

        const statuses = await db
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, issueRows[0].projectId));
        const target = statuses.find((s) => s.name === statusName);
        if (!target) {
          console.error(`Status '${statusName}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
          process.exit(1);
        }

        const now = new Date().toISOString();
        await db
          .update(issues)
          .set({ statusId: target.id, statusChangedAt: now, updatedAt: now })
          .where(eq(issues.id, issueRows[0].id));

        await syncCurrentNodeToStatus(db, issueRows[0].id).catch(() => {});

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

        const issueRows = await db
          .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, priority: issues.priority, issueType: issues.issueType, statusName: projectStatuses.name })
          .from(issues)
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
          .limit(1);

        if (issueRows.length === 0) {
          console.error(`Issue #${num} not found.`);
          process.exit(1);
        }

        const issue = issueRows[0];
        const projectRows = await db
          .select({ defaultBranch: projects.defaultBranch })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        const projectDefaultBranch = projectRows[0]?.defaultBranch ?? null;

        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.issueId, issue.id));

        if (wsRows.length === 0) {
          console.log(`#${num} ${issue.title}`);
          console.log(`  Status: ${issue.statusName} · Type: ${issue.issueType ?? "task"}`);
          console.log("  No workspace.");
          process.exit(0);
        }

        const wsIds = wsRows.map(w => w.id);
        const sessionRows = await db
          .select()
          .from(sessions)
          .where(inArray(sessions.workspaceId, wsIds))
          .orderBy(desc(sessions.startedAt));

        const latestSession = sessionRows.find(s => !isAnalyticsNoise(s)) ?? sessionRows[0] ?? null;
        const matchingWs = latestSession ? wsRows.find(w => w.id === latestSession.workspaceId) : wsRows[0];

        let lastAgentMsg: string | null = null;
        let fileChanges: { read: number; edited: number; written: number } | null = null;
        let diffStats: WorkspaceDiffStats | null = null;

        if (matchingWs) {
          diffStats = await getWorkspaceDiffStats(matchingWs, projectDefaultBranch);
        }

        if (latestSession) {
          const msgRows = await db
            .select()
            .from(sessionMessages)
            .where(eq(sessionMessages.sessionId, latestSession.id))
            .orderBy(desc(sessionMessages.id));

          for (const row of msgRows) {
            if (row.type !== "stdout" || !row.data) continue;
            const lines = row.data.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const obj = JSON.parse(trimmed);
                if (obj.type === "assistant") {
                  const content = obj.message?.content as Array<Record<string, unknown>> | undefined;
                  if (content) {
                    for (const block of [...content].reverse()) {
                      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                        lastAgentMsg = block.text;
                      }
                    }
                  }
                }
                if (obj.type === "assistant.message") {
                  const data = obj.data as Record<string, unknown> | undefined;
                  if (data) {
                    const raw = data.content;
                    const contentStr = typeof raw === "string" ? raw
                      : Array.isArray(raw)
                        ? (raw as { type?: string; text?: string }[])
                            .filter(b => b.type === "text" && typeof b.text === "string")
                            .map(b => b.text as string)
                            .join("\n")
                        : "";
                    if (contentStr.trim()) lastAgentMsg = contentStr;
                  }
                }
                if (obj.type === "item.completed" && obj.item?.type === "agent_message" && typeof obj.item.text === "string") {
                  lastAgentMsg = obj.item.text;
                }
              } catch { /* not JSON */ }
            }
            if (lastAgentMsg) break;
          }

          const summary = parseSessionSummary(msgRows);
          fileChanges = { read: summary.filesRead.length, edited: summary.filesEdited.length, written: summary.filesWritten.length };
        }

        if (options.json) {
          console.log(JSON.stringify({
            issueNumber: issue.issueNumber,
            title: issue.title,
            status: issue.statusName,
            priority: issue.priority,
            workspace: matchingWs ? {
              id: matchingWs.id,
              branch: matchingWs.branch,
              status: matchingWs.status,
              isDirect: matchingWs.isDirect,
              provider: matchingWs.provider,
            } : null,
            session: latestSession ? {
              id: latestSession.id,
              status: latestSession.status,
              startedAt: latestSession.startedAt,
              endedAt: latestSession.endedAt,
            } : null,
            lastAgentMessage: lastAgentMsg,
            fileChanges,
            diffStats,
          }, null, 2));
          process.exit(0);
        }

        console.log(`\n  #${num} ${issue.title}`);
        console.log(`  Status: ${issue.statusName} · Type: ${issue.issueType ?? "task"}`);

        if (matchingWs) {
          const wsType = matchingWs.isDirect ? "direct" : "worktree";
          const parts = [matchingWs.branch, wsType, matchingWs.status];
          if (matchingWs.provider) parts.push(matchingWs.provider);
          console.log(`  Workspace: ${matchingWs.id.slice(0, 8)} (${parts.join(", ")})`);
        }

        if (latestSession) {
          const agoMs = Date.now() - new Date(latestSession.startedAt).getTime();
          const ago = formatDurationStr(agoMs);
          let duration = "?";
          if (latestSession.endedAt && latestSession.startedAt) {
            duration = formatDurationStr(new Date(latestSession.endedAt).getTime() - new Date(latestSession.startedAt).getTime());
          }
          console.log(`  Session:  ${latestSession.id.slice(0, 8)} (${latestSession.status}, ${ago} ago, lasted ${duration})`);
        }

        if (diffStats && (diffStats.filesChanged > 0 || diffStats.insertions > 0 || diffStats.deletions > 0)) {
          console.log(`  Diff: ${diffStats.filesChanged} file${diffStats.filesChanged === 1 ? "" : "s"}, +${diffStats.insertions}/-${diffStats.deletions}`);
        } else if (fileChanges && (fileChanges.read || fileChanges.edited || fileChanges.written)) {
          const parts: string[] = [];
          if (fileChanges.read) parts.push(`${fileChanges.read} read`);
          if (fileChanges.edited) parts.push(`${fileChanges.edited} edited`);
          if (fileChanges.written) parts.push(`${fileChanges.written} written`);
          console.log(`  Files: ${parts.join(", ")}`);
        } else {
          console.log("  No file changes.");
        }

        if (lastAgentMsg) {
          console.log(`\n  Last agent message:`);
          const wrapped = lastAgentMsg.length > 200 ? lastAgentMsg.slice(0, 197) + "..." : lastAgentMsg;
          for (const line of wrapped.split("\n")) {
            console.log(`    ${line}`);
          }
        }
        console.log("");
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

        const issueRows = await db
          .select()
          .from(issues)
          .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
          .limit(1);

        if (issueRows.length === 0) {
          console.error(`Issue #${num} not found.`);
          process.exit(1);
        }

        const issue = issueRows[0];

        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.issueId, issue.id));

        if (wsRows.length === 0) {
          console.log(`#${num} ${issue.title}`);
          console.log("  No workspace found for this issue.");
          process.exit(0);
        }

        const wsIds = wsRows.map(w => w.id);
        const sessionRows = await db
          .select()
          .from(sessions)
          .where(inArray(sessions.workspaceId, wsIds))
          .orderBy(desc(sessions.startedAt));

        const nonNoiseSessions = sessionRows.filter(s => !isAnalyticsNoise(s));
        const relevantSessions = nonNoiseSessions.length > 0 ? nonNoiseSessions : sessionRows;
        const completedSession = relevantSessions.find(s => s.status === "completed" || s.status === "stopped")
          ?? relevantSessions[0]
          ?? null;

        if (!completedSession) {
          console.log(`#${num} ${issue.title}`);
          console.log("  No session found for this issue.");
          process.exit(0);
        }

        const msgRows = await db
          .select()
          .from(sessionMessages)
          .where(eq(sessionMessages.sessionId, completedSession.id))
          .orderBy(sessionMessages.id);

        let stats: Record<string, unknown> | null = null;
        if (completedSession.stats) {
          try { stats = JSON.parse(completedSession.stats); } catch { /* ignore */ }
        }

        let duration: string | null = null;
        if (completedSession.endedAt && completedSession.startedAt) {
          const diffMs = new Date(completedSession.endedAt).getTime() - new Date(completedSession.startedAt).getTime();
          duration = formatDurationStr(diffMs);
        }

        const summary = parseSessionSummary(msgRows);
        if (!summary.agentSummary && stats && typeof (stats as any).agentSummary === "string") {
          summary.agentSummary = (stats as any).agentSummary;
        }

        const matchingWorkspace = wsRows.find(w => w.id === completedSession.workspaceId);

        if (options.json) {
          console.log(JSON.stringify({
            issueId: issue.id,
            issueNumber: issue.issueNumber,
            title: issue.title,
            workspace: matchingWorkspace ? {
              id: matchingWorkspace.id,
              branch: matchingWorkspace.branch,
              status: matchingWorkspace.status,
            } : null,
            session: {
              id: completedSession.id,
              status: completedSession.status,
              startedAt: completedSession.startedAt,
              endedAt: completedSession.endedAt,
              duration,
            },
            stats: stats ? {
              durationMs: (stats as any).durationMs ?? 0,
              totalCostUsd: (stats as any).totalCostUsd ?? 0,
              inputTokens: (stats as any).inputTokens ?? 0,
              outputTokens: (stats as any).outputTokens ?? 0,
              numTurns: (stats as any).numTurns ?? 1,
              model: (stats as any).model ?? summary.model,
              success: (stats as any).success ?? false,
            } : null,
            ...summary,
          }, null, 2));
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

  // ── dependency sub-commands ──
  const depCmd = issueCmd.command("dependency").description("Manage issue dependencies.\n\nDependencies link issues together with typed relationships. Available types: depends_on, blocked_by, related_to, duplicates, parent_of, child_of.\n\nSubcommands: list, add, remove");

  depCmd
    .command("list <issue-id>")
    .description("List dependencies for an issue.\n\nShows both outgoing (this issue depends on others) and incoming (others depend on this issue) dependencies.")
    .addHelpText("after", `
Example:
  $ agentic-kanban issue dependency list abc123-def456-...
`)
    .action(async (issueId: string) => {
      try {
        await runMigrations();

        const outgoing = await db
          .select({
            id: issueDependencies.id,
            type: issueDependencies.type,
            targetTitle: issues.title,
            targetNumber: issues.issueNumber,
            targetStatusName: projectStatuses.name,
          })
          .from(issueDependencies)
          .innerJoin(issues, eq(issueDependencies.dependsOnId, issues.id))
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(eq(issueDependencies.issueId, issueId));

        const incoming = await db
          .select({
            id: issueDependencies.id,
            type: issueDependencies.type,
            sourceTitle: issues.title,
            sourceNumber: issues.issueNumber,
            sourceStatusName: projectStatuses.name,
          })
          .from(issueDependencies)
          .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
          .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
          .where(eq(issueDependencies.dependsOnId, issueId));

        if (outgoing.length === 0 && incoming.length === 0) {
          console.log("No dependencies found.");
          process.exit(0);
        }

        if (outgoing.length > 0) {
          console.log("Outgoing:");
          for (const dep of outgoing) {
            const num = dep.targetNumber != null ? `#${dep.targetNumber}` : "(no number)";
            console.log(`  [${dep.type}] ${num} ${dep.targetTitle} (${dep.targetStatusName})`);
            console.log(`    id: ${dep.id}`);
          }
        }

        if (incoming.length > 0) {
          console.log("Incoming:");
          for (const dep of incoming) {
            const num = dep.sourceNumber != null ? `#${dep.sourceNumber}` : "(no number)";
            console.log(`  [${dep.type}] ${num} ${dep.sourceTitle} (${dep.sourceStatusName})`);
            console.log(`    id: ${dep.id}`);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("add <issue-id> <target-id>")
    .description("Add a dependency between two issues.\n\nCreates a typed link from <issue-id> to <target-id>. Both issues must belong to the same project. Self-dependencies and duplicate links are rejected.")
    .option("-t, --type <type>", "Dependency type: depends_on, blocked_by, related_to, duplicates, parent_of, child_of (default: depends_on)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue dependency add abc123 def456                       # abc123 depends_on def456
  $ agentic-kanban issue dependency add abc123 def456 -t blocked_by         # abc123 is blocked_by def456
  $ agentic-kanban issue dependency add abc123 def456 -t parent_of          # abc123 is parent_of def456
`)
    .action(async (issueId: string, targetId: string, options: { type?: string }) => {
      try {
        await runMigrations();

        const depType = options.type || "depends_on";
        const validTypes = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];
        if (!validTypes.includes(depType)) {
          console.error(`Invalid type '${depType}'. Valid types: ${validTypes.join(", ")}`);
          process.exit(1);
        }

        if (issueId === targetId) {
          console.error("An issue cannot depend on itself.");
          process.exit(1);
        }

        const [sourceIssue, targetIssue] = await Promise.all([
          db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
          db.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, targetId)).limit(1),
        ]);

        if (sourceIssue.length === 0) {
          console.error(`Issue '${issueId}' not found.`);
          process.exit(1);
        }
        if (targetIssue.length === 0) {
          console.error(`Issue '${targetId}' not found.`);
          process.exit(1);
        }
        if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
          console.error("Cannot add dependencies across projects.");
          process.exit(1);
        }

        const id = randomUUID();
        try {
          await db.insert(issueDependencies).values({
            id,
            issueId,
            dependsOnId: targetId,
            type: depType as typeof DEPENDENCY_TYPES[number],
            createdAt: new Date().toISOString(),
          });
        } catch (err: any) {
          if (err.message?.includes("UNIQUE constraint")) {
            console.error("This dependency already exists.");
            process.exit(1);
          }
          throw err;
        }

        console.log(`Added '${depType}' dependency: ${issueId} -> ${targetId}`);
        console.log(`  id: ${id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("remove <dependency-id>")
    .description("Remove a dependency by its ID.\n\nUse 'issue dependency list' to find the dependency ID.")
    .addHelpText("after", `
Example:
  $ agentic-kanban issue dependency list abc123  # find the dependency ID
  $ agentic-kanban issue dependency remove dep-abc-def
`)
    .action(async (dependencyId: string) => {
      try {
        await runMigrations();

        const rows = await db.delete(issueDependencies).where(eq(issueDependencies.id, dependencyId)).returning();
        if (rows.length === 0) {
          console.error(`Dependency '${dependencyId}' not found.`);
          process.exit(1);
        }

        console.log(`Removed dependency '${dependencyId}'.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("analyze <issue-number>")
    .description("Analyze dependencies for an issue against the current board.\n\nCalls the server's dependency-analysis endpoint to infer and create dependency edges. Requires the dev server to be running.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue dependency analyze 42
  $ agentic-kanban issue dependency analyze 42 --json
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

        const issueRows = await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
          .limit(1);

        if (issueRows.length === 0) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        const issueId = issueRows[0].id;
        const port = process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(`http://127.0.0.1:${port}/api/issues/analyze-dependencies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId, projectId }),
        });
        const text = await res.text();
        if (!res.ok) {
          console.error(`Dependency analysis failed (${res.status}): ${text}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(text);
        } else {
          try {
            const parsed = JSON.parse(text);
            console.log(JSON.stringify(parsed, null, 2));
          } catch {
            console.log(text);
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  depCmd
    .command("update-batch <jsonFile>")
    .description("Add or remove multiple dependency edges atomically from a JSON file.\n\nReads a JSON file containing an array of edge operations. Idempotent: existing adds and missing removes are skipped. Cycle detection is applied; rolls back on cycle.")
    .option("--json", "Output raw JSON instead of formatted text")
    .addHelpText("after", `
Examples:
  $ agentic-kanban issue dependency update-batch edges.json
  $ agentic-kanban issue dependency update-batch edges.json --json

JSON file format:
  [
    { "issueId": "<uuid>", "dependsOnId": "<uuid>", "type": "depends_on", "action": "add" },
    { "issueId": "<uuid>", "dependsOnId": "<uuid>", "type": "blocked_by", "action": "remove" }
  ]

Valid types: depends_on, blocked_by, related_to, duplicates, parent_of, child_of
Valid actions: add, remove
`)
    .action(async (jsonFile: string, options: { json?: boolean }) => {
      try {
        await runMigrations();

        let fileContent: string;
        try {
          fileContent = readFileSync(jsonFile, "utf8");
        } catch (err) {
          console.error(`Could not read file '${jsonFile}': ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        let edges: Array<{ issueId: string; dependsOnId: string; type?: string; action: "add" | "remove" }>;
        try {
          edges = JSON.parse(fileContent);
        } catch {
          console.error("Invalid JSON in file.");
          process.exit(1);
        }

        if (!Array.isArray(edges)) {
          console.error("JSON file must contain an array of edge operations.");
          process.exit(1);
        }

        const VALID_TYPES = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"] as const;
        const DIRECTIONAL = new Set<string>(["depends_on", "blocked_by", "parent_of", "child_of"]);

        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          if (!e.issueId || !e.dependsOnId || !e.action) {
            console.error(`edges[${i}]: missing required fields (issueId, dependsOnId, action).`);
            process.exit(1);
          }
          if (!["add", "remove"].includes(e.action)) {
            console.error(`edges[${i}]: action must be 'add' or 'remove'.`);
            process.exit(1);
          }
          if (e.type && !(VALID_TYPES as readonly string[]).includes(e.type)) {
            console.error(`edges[${i}]: invalid type '${e.type}'. Valid: ${VALID_TYPES.join(", ")}`);
            process.exit(1);
          }
          if (e.action === "add" && e.issueId === e.dependsOnId) {
            console.error(`edges[${i}]: an issue cannot depend on itself.`);
            process.exit(1);
          }
        }

        const issueIds = [...new Set(edges.flatMap((e) => [e.issueId, e.dependsOnId]))];
        const issueRows = issueIds.length === 0 ? [] : await getIssueIdsAndProjectsForBatch(issueIds);
        const projectByIssue = new Map(issueRows.map((r) => [r.id, r.projectId]));

        const projectIds = [...new Set(issueRows.map((r) => r.projectId))];
        const allDepRows = projectIds.length === 0 ? [] : await getDependencyRowsForProjects(projectIds);

        const adjByProject = new Map<string, Map<string, Set<string>>>();
        const edgeKeyToRow = new Map<string, { id: string; projectId: string }>();
        for (const dep of allDepRows) {
          if (DIRECTIONAL.has(dep.type)) {
            let adj = adjByProject.get(dep.projectId);
            if (!adj) { adj = new Map(); adjByProject.set(dep.projectId, adj); }
            let set = adj.get(dep.issueId);
            if (!set) { set = new Set(); adj.set(dep.issueId, set); }
            set.add(dep.dependsOnId);
          }
          edgeKeyToRow.set(`${dep.issueId}|${dep.dependsOnId}|${dep.type}`, { id: dep.id, projectId: dep.projectId });
        }

        const skipped: { edge: typeof edges[number]; reason: string }[] = [];
        let added = 0;
        let removed = 0;
        let cycleError: string | null = null;

        await db.transaction(async (tx) => {
          for (let i = 0; i < edges.length; i++) {
            const e = edges[i];
            const type = (e.type ?? "depends_on") as typeof VALID_TYPES[number];
            const srcProj = projectByIssue.get(e.issueId);
            const tgtProj = projectByIssue.get(e.dependsOnId);

            if (e.action === "add") {
              if (!srcProj) { skipped.push({ edge: e, reason: "source issue not found" }); continue; }
              if (!tgtProj) { skipped.push({ edge: e, reason: "target issue not found" }); continue; }
              if (srcProj !== tgtProj) { skipped.push({ edge: e, reason: "cross-project dependency" }); continue; }

              const key = `${e.issueId}|${e.dependsOnId}|${type}`;
              if (edgeKeyToRow.has(key)) { skipped.push({ edge: e, reason: "already exists" }); continue; }

              if (DIRECTIONAL.has(type)) {
                let adj = adjByProject.get(srcProj);
                if (!adj) { adj = new Map(); adjByProject.set(srcProj, adj); }
                if (hasPath(adj, e.dependsOnId, e.issueId)) {
                  cycleError = `edges[${i}]: would create a cycle (${e.issueId} -> ${e.dependsOnId})`;
                  throw new Error(cycleError);
                }
                let set = adj.get(e.issueId);
                if (!set) { set = new Set(); adj.set(e.issueId, set); }
                set.add(e.dependsOnId);
              }

              const id = randomUUID();
              await tx.insert(issueDependencies).values({
                id,
                issueId: e.issueId,
                dependsOnId: e.dependsOnId,
                type,
                createdAt: new Date().toISOString(),
              });
              edgeKeyToRow.set(`${e.issueId}|${e.dependsOnId}|${type}`, { id, projectId: srcProj });
              added++;
            } else {
              const key = `${e.issueId}|${e.dependsOnId}|${type}`;
              const row = edgeKeyToRow.get(key);
              if (!row) { skipped.push({ edge: e, reason: "dependency does not exist" }); continue; }
              await tx.delete(issueDependencies).where(eq(issueDependencies.id, row.id));
              edgeKeyToRow.delete(key);
              if (DIRECTIONAL.has(type)) {
                const adj = adjByProject.get(row.projectId);
                adj?.get(e.issueId)?.delete(e.dependsOnId);
              }
              removed++;
            }
          }
        }).catch((err) => {
          if (cycleError) return;
          throw err;
        });

        if (cycleError) {
          console.error(`Error: ${cycleError}`);
          process.exit(1);
        }

        const result = { added, removed, skipped };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Added: ${added}, Removed: ${removed}, Skipped: ${skipped.length}`);
          if (skipped.length > 0) {
            for (const s of skipped) {
              console.log(`  Skipped: ${s.edge.issueId} -> ${s.edge.dependsOnId} (${s.reason})`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

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

        const parentRows = await db
          .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.issueNumber, parentNum), eq(issues.projectId, projectId)))
          .limit(1);

        if (parentRows.length === 0) {
          console.error(`Parent issue #${parentNum} not found in active project.`);
          process.exit(1);
        }

        const parent = parentRows[0];

        const statuses = await db
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, parent.projectId))
          .orderBy(projectStatuses.sortOrder);

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

        const maxResult = await db
          .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
          .from(issues)
          .where(eq(issues.projectId, parent.projectId));
        const issueNumber = (maxResult[0]?.maxNum ?? 0) + 1;

        const id = randomUUID();
        const dependencyId = randomUUID();
        const now = new Date().toISOString();

        await db.transaction(async (tx) => {
          await tx.insert(issues).values({
            id,
            issueNumber,
            title,
            description: options.description ?? null,
            priority: (options.priority as "low" | "medium" | "high" | "critical") ?? "medium",
            issueType: (options.type as "task" | "bug" | "feature" | "chore") ?? "task",
            sortOrder: 0,
            statusId,
            projectId: parent.projectId,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(issueDependencies).values({
            id: dependencyId,
            issueId: id,
            dependsOnId: parent.id,
            type: "child_of",
            createdAt: now,
          });
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

        const issueRows = await db
          .select({ id: issues.id, title: issues.title, projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
          .limit(1);

        if (issueRows.length === 0) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        const issue = issueRows[0];

        if (!options.force) {
          console.log(`Warning: This will permanently delete issue #${num} "${issue.title}" and ALL associated workspaces, sessions, and messages. Use --force to suppress this message.`);
        }

        // Cascade: workspaces → sessions → messages → diff_comments
        const wsRows = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.issueId, issue.id));

        for (const ws of wsRows) {
          const wsSessions = await db
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.workspaceId, ws.id));

          await db.delete(diffComments).where(eq(diffComments.workspaceId, ws.id));
          if (wsSessions.length > 0) {
            await db.delete(sessionMessages).where(inArray(sessionMessages.sessionId, wsSessions.map((s) => s.id)));
          }
          await db.delete(sessions).where(eq(sessions.workspaceId, ws.id));
          await db.delete(workspaces).where(eq(workspaces.id, ws.id));
        }

        await db.delete(issueTags).where(eq(issueTags.issueId, issue.id));
        await db.delete(issues).where(eq(issues.id, issue.id));

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

        const num = Number(issueNumberArg);
        if (!Number.isInteger(num) || num <= 0) {
          console.error(`Invalid issue number: ${issueNumberArg}`);
          process.exit(1);
        }

        if (!options.type) {
          console.error("--type is required. Valid: text, link, image");
          process.exit(1);
        }
        const ARTIFACT_TYPES = ["text", "link", "image"] as const;
        if (!(ARTIFACT_TYPES as readonly string[]).includes(options.type)) {
          console.error(`Invalid type '${options.type}'. Valid: ${ARTIFACT_TYPES.join(", ")}`);
          process.exit(1);
        }
        if (!options.content || !options.content.trim()) {
          console.error("--content is required and cannot be empty.");
          process.exit(1);
        }

        const issueRows = await db
          .select({ id: issues.id, projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.issueNumber, num), eq(issues.projectId, projectId)))
          .limit(1);

        if (issueRows.length === 0) {
          console.error(`Issue #${num} not found in active project.`);
          process.exit(1);
        }

        const issue = issueRows[0];

        if (options.workspace) {
          const wsRows = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(and(eq(workspaces.id, options.workspace), eq(workspaces.issueId, issue.id)))
            .limit(1);
          if (wsRows.length === 0) {
            console.error(`Workspace '${options.workspace}' not found or does not belong to issue #${num}.`);
            process.exit(1);
          }
        }

        const id = randomUUID();
        await db.insert(issueArtifacts).values({
          id,
          issueId: issue.id,
          workspaceId: options.workspace ?? null,
          type: options.type as typeof ARTIFACT_TYPES[number],
          mimeType: options.mimeType ?? null,
          content: options.content,
          caption: options.caption ?? null,
        });

        const result = {
          id,
          issueId: issue.id,
          workspaceId: options.workspace ?? null,
          type: options.type,
          mimeType: options.mimeType ?? null,
          caption: options.caption ?? null,
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Attached ${options.type} artifact to issue #${num}.`);
          console.log(`  id: ${id}`);
          if (options.caption) console.log(`  caption: ${options.caption}`);
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

        // Accept either { issues: [...], dependencies: [...] } or bare array
        let issueInputs: Array<{
          title: string;
          description?: string;
          priority?: "low" | "medium" | "high" | "critical";
          issueType?: string;
          estimate?: string | null;
          sortOrder?: number;
          statusName?: string;
          tags?: string[];
        }>;
        let dependencyInputs: Array<{ issueIndex: number; dependsOnIndex: number; type?: string }> = [];

        if (Array.isArray(parsed)) {
          issueInputs = parsed as typeof issueInputs;
        } else if (parsed && typeof parsed === "object" && "issues" in parsed && Array.isArray((parsed as { issues: unknown }).issues)) {
          const p = parsed as { issues: typeof issueInputs; dependencies?: typeof dependencyInputs };
          issueInputs = p.issues;
          dependencyInputs = p.dependencies ?? [];
        } else {
          console.error("JSON must be an array of issues or an object with an 'issues' array.");
          process.exit(1);
        }

        const statuses = await db
          .select()
          .from(projectStatuses)
          .where(eq(projectStatuses.projectId, projectId))
          .orderBy(projectStatuses.sortOrder);

        if (statuses.length === 0) {
          console.error("No statuses configured for project.");
          process.exit(1);
        }

        for (let i = 0; i < issueInputs.length; i++) {
          if (!issueInputs[i].title?.trim()) {
            console.error(`issues[${i}].title is required.`);
            process.exit(1);
          }
          if (issueInputs[i].statusName && !statuses.find((s) => s.name === issueInputs[i].statusName)) {
            console.error(`issues[${i}].statusName '${issueInputs[i].statusName}' not found. Available: ${statuses.map((s) => s.name).join(", ")}`);
            process.exit(1);
          }
        }

        let parentIssueId: string | undefined;
        if (options.parent) {
          const parentNum = Number(options.parent);
          if (!Number.isInteger(parentNum) || parentNum <= 0) {
            console.error(`Invalid parent issue number: ${options.parent}`);
            process.exit(1);
          }
          const parentRows = await db
            .select({ id: issues.id, projectId: issues.projectId })
            .from(issues)
            .where(and(eq(issues.issueNumber, parentNum), eq(issues.projectId, projectId)))
            .limit(1);
          if (parentRows.length === 0) {
            console.error(`Parent issue #${parentNum} not found in active project.`);
            process.exit(1);
          }
          parentIssueId = parentRows[0].id;
        }

        const maxResult = await db
          .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
          .from(issues)
          .where(eq(issues.projectId, projectId));
        let nextNumber = (maxResult[0]?.maxNum ?? 0) + 1;

        const now = new Date().toISOString();
        const created: { id: string; issueNumber: number; title: string }[] = [];

        await db.transaction(async (tx) => {
          const tagIdByName = new Map<string, string>();
          const resolveTagId = async (name: string): Promise<string> => {
            const key = name.toLowerCase();
            const cached = tagIdByName.get(key);
            if (cached) return cached;
            const existing = await tx.select({ id: tags.id }).from(tags)
              .where(sql`lower(${tags.name}) = lower(${name})`)
              .limit(1);
            let tagId: string;
            if (existing.length > 0) {
              tagId = existing[0].id;
            } else {
              tagId = randomUUID();
              await tx.insert(tags).values({ id: tagId, name, color: null, createdAt: now });
            }
            tagIdByName.set(key, tagId);
            return tagId;
          };

          const idByIndex: string[] = [];
          for (const input of issueInputs) {
            const id = randomUUID();
            const statusId = input.statusName
              ? statuses.find((s) => s.name === input.statusName)!.id
              : statuses[0].id;
            const issueNumber = nextNumber++;
            await tx.insert(issues).values({
              id,
              issueNumber,
              title: input.title,
              description: input.description ?? null,
              priority: input.priority ?? "medium",
              issueType: input.issueType ?? "task",
              sortOrder: input.sortOrder ?? 0,
              estimate: input.estimate ?? null,
              statusId,
              projectId,
              createdAt: now,
              updatedAt: now,
            });
            if (parentIssueId) {
              await tx.insert(issueDependencies).values({
                id: randomUUID(),
                issueId: id,
                dependsOnId: parentIssueId,
                type: "child_of",
                createdAt: now,
              });
            }
            if (input.tags && input.tags.length > 0) {
              const seenTagIds = new Set<string>();
              for (const tagName of input.tags) {
                const trimmed = tagName.trim();
                if (!trimmed) continue;
                const tagId = await resolveTagId(trimmed);
                if (seenTagIds.has(tagId)) continue;
                seenTagIds.add(tagId);
                await tx.insert(issueTags).values({ id: randomUUID(), issueId: id, tagId });
              }
            }
            idByIndex.push(id);
            created.push({ id, issueNumber, title: input.title });
          }

          for (const e of dependencyInputs) {
            if (e.issueIndex < 0 || e.issueIndex >= issueInputs.length) {
              throw new Error(`dependencies: issueIndex ${e.issueIndex} out of range (0..${issueInputs.length - 1})`);
            }
            if (e.dependsOnIndex < 0 || e.dependsOnIndex >= issueInputs.length) {
              throw new Error(`dependencies: dependsOnIndex ${e.dependsOnIndex} out of range (0..${issueInputs.length - 1})`);
            }
            await tx.insert(issueDependencies).values({
              id: randomUUID(),
              issueId: idByIndex[e.issueIndex],
              dependsOnId: idByIndex[e.dependsOnIndex],
              type: (e.type ?? "depends_on") as typeof DEPENDENCY_TYPES[number],
              createdAt: now,
            });
          }
        });

        const result = { issues: created, dependenciesCreated: dependencyInputs.length };
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Created ${created.length} issue(s)${dependencyInputs.length > 0 ? ` with ${dependencyInputs.length} dependency edge(s)` : ""}.`);
          for (const c of created) {
            console.log(`  #${c.issueNumber} ${c.title} (${c.id})`);
          }
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

        const issueRows = await db
          .select({ id: issues.id, issueNumber: issues.issueNumber, touchedFilesJson: issues.touchedFilesJson })
          .from(issues)
          .where(and(inArray(issues.issueNumber, nums), eq(issues.projectId, projectId)));

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
          try { files = JSON.parse(row.touchedFilesJson); } catch { continue; }
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

        const result: Record<string, unknown> = { overlap };
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
