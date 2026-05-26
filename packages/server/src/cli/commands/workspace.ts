import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projects, workspaces } from "@agentic-kanban/shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { runMigrations, getActiveProjectId } from "../shared.js";

export function registerWorkspaceCommand(program: Command) {
  const wsCmd = program.command("workspace").description("Manage workspaces (git worktrees linked to issues).\n\nWorkspaces create isolated git worktrees where agents can work on issues. Each workspace is tied to a single issue.\n\nSubcommands: list, create");

  wsCmd
    .command("list")
    .description("List workspaces for the active project.\n\nShows workspace status, branch name, ID, and working directory.")
    .option("-s, --status <status>", "Filter by status: active, idle, closed")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace list              # all workspaces
  $ agentic-kanban workspace list -s active    # only active workspaces
  $ agentic-kanban workspace list -s closed    # only closed/merged workspaces
`)
    .action(async (options: { status?: string }) => {
      try {
        await runMigrations();
        const projectId = await getActiveProjectId();

        const projectIssues = await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.projectId, projectId));

        if (projectIssues.length === 0) {
          console.log("No workspaces found (no issues in active project).");
          process.exit(0);
        }

        const issueIds = projectIssues.map((i) => i.id);
        let rows = await db.select().from(workspaces).where(inArray(workspaces.issueId, issueIds));

        if (options.status) rows = rows.filter((r) => r.status === options.status);

        if (rows.length === 0) {
          console.log("No workspaces found.");
          process.exit(0);
        }

        for (const ws of rows) {
          console.log(`  [${ws.status.padEnd(6)}] ${ws.branch}`);
          console.log(`         id: ${ws.id}`);
          if (ws.workingDir) console.log(`         dir: ${ws.workingDir}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("create <issue-id>")
    .description("Create a git worktree workspace for an issue.\n\nCreates a new git worktree from the project's default branch (or a specified base branch) and links it to the issue. The worktree provides an isolated working directory where agents can make changes.\n\nNote: This only creates the worktree. To launch an agent, use the web UI or MCP tools.")
    .option("-b, --branch <branch>", "Branch name (default: workspace/<issue-id-short>)")
    .option("--base <baseBranch>", "Base branch to create from (default: project default branch)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace create abc123                           # auto branch name
  $ agentic-kanban workspace create abc123 -b fix/login              # custom branch name
  $ agentic-kanban workspace create abc123 --base develop            # base off 'develop' branch

Tip: Use 'issue list' to find the issue ID.
`)
    .action(async (issueId: string, options: { branch?: string; base?: string }) => {
      try {
        await runMigrations();

        const issueRows = await db.select().from(issues).where(eq(issues.id, issueId)).limit(1);
        if (issueRows.length === 0) {
          console.error(`Issue '${issueId}' not found.`);
          process.exit(1);
        }

        const projectRows = await db
          .select()
          .from(projects)
          .where(eq(projects.id, issueRows[0].projectId))
          .limit(1);
        if (projectRows.length === 0 || !projectRows[0].repoPath) {
          console.error("Project has no repo path configured.");
          process.exit(1);
        }

        const project = projectRows[0];
        const { createWorktree } = await import("../../services/git.service.js");

        const branchName = options.branch ?? `workspace/${issueId.slice(0, 8)}`;
        const baseBranch = options.base ?? project.defaultBranch;
        if (!baseBranch) {
          console.error("No base branch configured. Set the project's default branch in settings or pass --base <branch>.");
          process.exit(1);
        }
        const worktreePath = await createWorktree(project.repoPath, branchName, baseBranch);

        const id = randomUUID();
        const now = new Date().toISOString();

        await db.insert(workspaces).values({
          id,
          issueId,
          branch: branchName,
          workingDir: worktreePath,
          baseBranch,
          isDirect: false,
          status: "active",
          createdAt: now,
          updatedAt: now,
        });

        console.log(`Created workspace for issue '${issueId}'`);
        console.log(`  id: ${id}`);
        console.log(`  branch: ${branchName}`);
        console.log(`  dir: ${worktreePath}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("launch <workspace-id>")
    .description("Relaunch an idle workspace by starting a new agent session.\n\nRequires the kanban server to be running (pnpm dev). The workspace must be in 'idle' status.")
    .option("--prompt <text>", "Prompt to send to the agent (default: issue title + description)")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace launch <workspace-id>
  $ agentic-kanban workspace launch <workspace-id> --prompt "Fix the failing tests"
`)
    .action(async (workspaceId: string, options: { prompt?: string; port?: string }) => {
      try {
        await runMigrations();

        const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
        if (wsRows.length === 0) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }

        const ws = wsRows[0];
        let prompt = options.prompt;
        if (!prompt) {
          const issueRows = await db.select({ title: issues.title, description: issues.description }).from(issues).where(eq(issues.id, ws.issueId)).limit(1);
          if (issueRows.length > 0) {
            prompt = issueRows[0].description
              ? `${issueRows[0].title}\n\n${issueRows[0].description}`
              : issueRows[0].title;
          } else {
            prompt = "Continue working on this issue.";
          }
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(`http://localhost:${port}/api/workspaces/${workspaceId}/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Launch failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Launched workspace '${workspaceId}'`);
        console.log(`  sessionId: ${data.sessionId}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("resume <issue-number>")
    .description("Resume the latest workspace for an issue by launching a new agent session.\n\nLooks up the workspace by issue number and calls the launch API. Auto-builds the prompt from the issue title/description if not provided. Requires the kanban server to be running (pnpm dev).")
    .option("--prompt <text>", "Prompt to send to the agent (default: issue title + description)")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace resume 17
  $ agentic-kanban workspace resume 17 --prompt "Continue fixing the setup script"
`)
    .action(async (issueNumberArg: string, options: { prompt?: string; port?: string }) => {
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
          console.error(`Issue #${num} not found.`);
          process.exit(1);
        }

        const wsRows = await db
          .select()
          .from(workspaces)
          .where(eq(workspaces.issueId, issueRows[0].id))
          .orderBy(desc(workspaces.updatedAt));

        if (wsRows.length === 0) {
          console.error(`No workspace found for issue #${num}. Create one first.`);
          process.exit(1);
        }

        const ws = wsRows[0];
        let prompt = options.prompt;
        if (!prompt) {
          const issueDetail = await db.select({ title: issues.title, description: issues.description }).from(issues).where(eq(issues.id, ws.issueId)).limit(1);
          if (issueDetail.length > 0) {
            prompt = issueDetail[0].description
              ? `${issueDetail[0].title}\n\n${issueDetail[0].description}`
              : issueDetail[0].title;
          } else {
            prompt = "Continue working on this issue.";
          }
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(`http://localhost:${port}/api/workspaces/${ws.id}/launch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Resume failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Resumed #${num} (${ws.branch})`);
        console.log(`  workspace: ${ws.id}`);
        console.log(`  sessionId: ${data.sessionId}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("review <workspace-id>")
    .description("Trigger an AI code review for an idle workspace.\n\nRequires the kanban server to be running (pnpm dev). The workspace must be in 'idle' status.")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace review <workspace-id>
`)
    .action(async (workspaceId: string, options: { port?: string }) => {
      try {
        await runMigrations();

        const wsRows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
        if (wsRows.length === 0) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(`http://localhost:${port}/api/workspaces/${workspaceId}/review`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Review failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Review started for workspace '${workspaceId}'`);
        console.log(`  sessionId: ${data.sessionId}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
