import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projectStatuses, workspaces, sessions, sessionMessages, issueDependencies, DEPENDENCY_TYPES, projects } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { parseSessionSummary, formatDurationStr } from "@agentic-kanban/shared";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { syncCurrentNodeToStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { isAnalyticsNoise } from "../../services/session-filter.js";
import { getWorkspaceDiffStats, type WorkspaceDiffStats } from "../../services/workspace-diff-stats.js";

export function registerIssueCommand(program: Command) {
  const issueCmd = program.command("issue").description("Manage issues on the board.\n\nSubcommands: list, create, move, summary, dependency");

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

        console.log(`\n  #${num} ${issue.title}`);

        if (matchingWorkspace) {
          console.log(`  workspace: ${matchingWorkspace.branch} (${matchingWorkspace.status})`);
        }

        console.log(`  session: ${completedSession.status}  duration: ${duration ?? "?"}`);

        if (stats) {
          const s = stats as any;
          const parts: string[] = [];
          if (s.model ?? summary.model) parts.push(`model: ${s.model ?? summary.model}`);
          if (s.numTurns > 0) parts.push(`turns: ${s.numTurns}`);
          if (s.totalCostUsd > 0) parts.push(`cost: $${s.totalCostUsd.toFixed(2)}`);
          if (s.inputTokens > 0 || s.outputTokens > 0) parts.push(`tokens: ${s.inputTokens ?? 0} in / ${s.outputTokens ?? 0} out`);
          if (parts.length > 0) console.log(`  ${parts.join("  ")}`);
        }

        if (summary.overview) {
          console.log(`  ${summary.overview}`);
        }

        if (summary.agentSummary) {
          console.log(`\n  Agent summary:`);
          for (const line of summary.agentSummary.split("\n")) {
            console.log(`    ${line}`);
          }
        }

        const allFiles = [...new Set([...summary.filesRead, ...summary.filesEdited, ...summary.filesWritten])];
        if (allFiles.length > 0) {
          console.log(`\n  Files (${allFiles.length}):`);
          for (const f of allFiles) {
            const tags: string[] = [];
            if (summary.filesEdited.includes(f)) tags.push("edited");
            if (summary.filesWritten.includes(f)) tags.push("written");
            if (summary.filesRead.includes(f) && tags.length === 0) tags.push("read");
            console.log(`    ${f} (${tags.join(", ")})`);
          }
        }

        if (summary.commandsRun.length > 0) {
          console.log(`\n  Commands (${summary.commandsRun.length}):`);
          for (const cmd of summary.commandsRun.slice(0, 10)) {
            console.log(`    ${cmd}`);
          }
          if (summary.commandsRun.length > 10) {
            console.log(`    ... and ${summary.commandsRun.length - 10} more`);
          }
        }

        if (summary.errors.length > 0) {
          console.log(`\n  Errors (${summary.errors.length}):`);
          for (const err of summary.errors.slice(0, 5)) {
            console.log(`    ${err}`);
          }
        }

        console.log("");
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
}
