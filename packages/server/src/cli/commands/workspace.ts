import type { Command } from "commander";
import { db } from "../../db/index.js";
import { issues, projects, workspaces, issueComments } from "@agentic-kanban/shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { proposeTransition, computeWorkspaceSignals } from "@agentic-kanban/shared/lib/workflow-engine";
import { randomUUID } from "node:crypto";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { buildWorkspaceApiUrl, buildApiUrl } from "./workspace-api-url.js";

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
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "launch"), {
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
        const res = await fetch(buildWorkspaceApiUrl(port, ws.id, "launch"), {
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
    .command("wait <issue-number>")
    .description("Block until a workspace leaves its active state, then exit.\n\nResolves the latest workspace for an issue number (same lookup as 'resume'), subscribes to the board WebSocket, and waits for the workspace to reach a terminal status. Prints each status transition as it arrives. Replaces sleep-loop polling of GET /api/workspaces/:id. Requires the kanban server to be running (pnpm dev).\n\nExit code 0: status reached idle, ready_for_merge, closed, or merged.\nExit code 1: status reached an error state, a workflow error was broadcast, the WS closed unexpectedly, or the timeout elapsed.")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .option("--timeout <seconds>", "Give up after N seconds (default: no timeout)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace wait 118                # block until #118 finishes
  $ agentic-kanban workspace wait 118 --timeout 600  # give up after 10 minutes
`)
    .action(async (issueNumberArg: string, options: { port?: string; timeout?: string }) => {
      try {
        const { runWorkspaceWait } = await import("./workspace-wait.js");
        const code = await runWorkspaceWait(issueNumberArg, options);
        process.exit(code);
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
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "review"), {
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

  // ─── New commands ───────────────────────────────────────────────────────────

  wsCmd
    .command("start <issue-id>")
    .description("One-step create + launch a workspace for an issue.\n\nPosts to POST /api/workspaces which creates the worktree, moves the issue to In Progress, and launches the agent in a single call. Requires the kanban server to be running (pnpm dev).")
    .option("--base <baseBranch>", "Base branch to create from (default: project default branch)")
    .option("--profile <claudeProfile>", "Claude profile to use for the agent session")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace start <issue-id>
  $ agentic-kanban workspace start <issue-id> --base develop
  $ agentic-kanban workspace start <issue-id> --profile anth
`)
    .action(async (issueId: string, options: { base?: string; profile?: string; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const body: Record<string, unknown> = { issueId };
        if (options.base) body.baseBranch = options.base;
        if (options.profile) body.claudeProfile = options.profile;

        const res = await fetch(buildApiUrl(port, "/api/workspaces"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Start failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Started workspace for issue '${issueId}'`);
        console.log(`  id: ${data.id}`);
        if (data.branch) console.log(`  branch: ${data.branch}`);
        if (data.workingDir) console.log(`  dir: ${data.workingDir}`);
        if (data.error) console.warn(`  warning: ${data.error}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("diff <workspace-id>")
    .description("Get the git diff for a workspace.\n\nReturns the diff between the workspace branch and its base branch. Requires the kanban server to be running (pnpm dev).")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace diff <workspace-id>
  $ agentic-kanban workspace diff <workspace-id> --json
`)
    .action(async (workspaceId: string, options: { json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "diff"));
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Diff failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.stats) console.log(`Stats: ${data.stats}`);
          if (Array.isArray(data.changedFiles) && data.changedFiles.length > 0) {
            console.log(`Changed files (${data.changedFiles.length}):`);
            for (const f of data.changedFiles as string[]) console.log(`  ${f}`);
          }
          if (data.diff) console.log("\n" + String(data.diff));
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("scorecard <workspace-id>")
    .description("Get the PR quality scorecard for a workspace.\n\nReturns a 0-100 score with per-dimension breakdown (Tests, Types, Scope, Diff size, Conflicts, Docs, Skill output). Requires the kanban server to be running (pnpm dev).")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace scorecard <workspace-id>
  $ agentic-kanban workspace scorecard <workspace-id> --json
`)
    .action(async (workspaceId: string, options: { json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "scorecard"));
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Scorecard failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.score !== undefined) console.log(`Score: ${data.score}/100`);
          if (data.computedAt) console.log(`Computed: ${data.computedAt}`);
          if (Array.isArray(data.dimensions)) {
            console.log("Dimensions:");
            for (const d of data.dimensions as Array<{ name: string; score: number; maxScore: number; signal: string }>) {
              console.log(`  ${d.name}: ${d.score}/${d.maxScore} — ${d.signal}`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("merge <workspace-id>")
    .description("Merge a workspace branch into the project's default branch.\n\nCloses the workspace and auto-transitions the issue to Done. Requires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace merge <workspace-id>
`)
    .action(async (workspaceId: string, options: { port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "merge"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Merge failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Merged workspace '${workspaceId}'`);
        if (data.mergeOutput) console.log(`  output: ${data.mergeOutput}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("close <workspace-id>")
    .description("Close a workspace without merging.\n\nUse for direct workspaces or abandoned work. Use 'merge' instead if you want to merge the branch. Requires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace close <workspace-id>
`)
    .action(async (workspaceId: string, options: { port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "close"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Close failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Closed workspace '${workspaceId}'`);
        console.log(`  status: ${data.status ?? "closed"}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("stop <workspace-id>")
    .description("Stop any running agent session for a workspace.\n\nRequires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace stop <workspace-id>
`)
    .action(async (workspaceId: string, options: { port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "stop"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Stop failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Stopped workspace '${workspaceId}'`);
        if (data.sessionsStopped !== undefined) console.log(`  sessions stopped: ${data.sessionsStopped}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("delete <workspace-id>")
    .description("Delete a workspace and all its sessions, messages, and diff comments.\n\nRequires the kanban server to be running (pnpm dev).")
    .option("--force", "Skip confirmation (for scripting)")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace delete <workspace-id>
  $ agentic-kanban workspace delete <workspace-id> --force
`)
    .action(async (workspaceId: string, options: { force?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}`), {
          method: "DELETE",
        });

        if (res.status === 204 || res.status === 200) {
          console.log(`Deleted workspace '${workspaceId}'`);
          process.exit(0);
        }

        const data = await res.json() as Record<string, unknown>;
        if (!res.ok) {
          console.error(`Delete failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Deleted workspace '${workspaceId}'`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("relaunch <workspace-id>")
    .description("Relaunch an idle workspace by starting a new agent session.\n\nThe workspace must be in 'idle' status. Requires the kanban server to be running (pnpm dev).")
    .option("--prompt <text>", "Prompt to send to the agent (default: issue title + description)")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace relaunch <workspace-id>
  $ agentic-kanban workspace relaunch <workspace-id> --prompt "Fix the failing tests"
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
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "launch"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Relaunch failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Relaunched workspace '${workspaceId}'`);
        console.log(`  sessionId: ${data.sessionId}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("mark-ready <workspace-id>")
    .description("Mark a workspace as reviewed and ready to merge.\n\nCall after a successful code review with no critical or major issues. Allows future agents to merge the workspace without requiring another review. Requires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace mark-ready <workspace-id>
`)
    .action(async (workspaceId: string, options: { port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "ready-for-merge"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Mark-ready failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Marked workspace '${workspaceId}' as ready for merge`);
        console.log(`  readyForMerge: ${data.readyForMerge ?? true}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("propose-transition <workspace-id> <target-status>")
    .description("Advance a workspace's workflow to the next stage.\n\nPosts to the workflow transition endpoint. Use when a stage's work is complete. Requires the kanban server to be running (pnpm dev).")
    .option("--summary <text>", "Short summary of what was completed at the current stage")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace propose-transition <workspace-id> Done
  $ agentic-kanban workspace propose-transition <workspace-id> Review --summary "Implementation complete"
`)
    .action(async (workspaceId: string, targetStatus: string, options: { summary?: string; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const body: Record<string, unknown> = { toNodeName: targetStatus };
        if (options.summary) body.summary = options.summary;

        const res = await fetch(buildApiUrl(port, `/api/workflows/workspaces/${encodeURIComponent(workspaceId)}/transition`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Transition failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Transitioned workspace '${workspaceId}'`);
        if (data.movedTo) console.log(`  movedTo: ${data.movedTo}`);
        if (data.status) console.log(`  status: ${data.status}`);
        if (Array.isArray(data.nextStages) && data.nextStages.length > 0) {
          console.log(`  nextStages: ${(data.nextStages as string[]).join(", ")}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("clarify <workspace-id>")
    .description("Raise a clarifying question or propose the next workflow gate for a workspace.\n\nMirrors the clarify_or_propose MCP tool: action=clarify persists a structured question to the issue's activity thread (visible in the interactive UI on next refresh); action=propose advances the workspace's workflow gate. Operates directly on the database — no running server required.")
    .option("--action <action>", "Action: clarify or propose (default: clarify)", "clarify")
    .option("--question <text>", "The clarifying question to ask (for action=clarify)")
    .option("--header <text>", "Short header for the question (for action=clarify)")
    .option("--to <nodeName>", "Target workflow stage (for action=propose)")
    .option("--summary <text>", "Short context or transition summary")
    .option("--tests-passed", "Mark tests as passed for conditional propose routing")
    .option("--json", "Output raw JSON")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace clarify <workspace-id> --question "Should I update the tests?"
  $ agentic-kanban workspace clarify <workspace-id> --action propose --to Done --summary "Implementation complete"
`)
    .action(async (workspaceId: string, options: { action?: string; question?: string; header?: string; to?: string; summary?: string; testsPassed?: boolean; json?: boolean }) => {
      try {
        await runMigrations();
        const action = options.action ?? "clarify";
        if (action !== "clarify" && action !== "propose") {
          console.error(`Invalid --action '${action}'. Use clarify or propose.`);
          process.exit(1);
        }

        const wsRows = await db
          .select({ issueId: workspaces.issueId, projectId: issues.projectId, issueNumber: issues.issueNumber })
          .from(workspaces)
          .innerJoin(issues, eq(workspaces.issueId, issues.id))
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        if (wsRows.length === 0) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }
        const ws = wsRows[0];

        if (action === "clarify") {
          if (!options.question || !options.question.trim()) {
            console.error("--question is required for action=clarify.");
            process.exit(1);
          }
          const toolUseId = `cli-clarify-${randomUUID()}`;
          const question = { question: options.question.trim(), header: options.header, options: [{ label: "Answer in free text" }] };
          const body = [
            options.summary?.trim() || "The phase agent needs clarification before continuing.",
            "",
            `1. ${question.header ? `${question.header}: ` : ""}${question.question}`,
          ].join("\n");
          await db.insert(issueComments).values({
            id: randomUUID(),
            issueId: ws.issueId,
            workspaceId,
            kind: "agent-question",
            author: "agent",
            body,
            payload: JSON.stringify({ toolUseId, questions: [question], source: "cli_clarify_or_propose" }),
            createdAt: new Date().toISOString(),
          });
          const result = { ok: true, action: "clarify", toolUseId, workspaceId, issueId: ws.issueId, issueNumber: ws.issueNumber, question };
          if (options.json) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
          console.log(`Clarifying question recorded for workspace '${workspaceId}' (issue #${ws.issueNumber}).`);
          console.log(`  toolUseId: ${toolUseId}`);
          console.log("  It is now visible in the interactive UI on next refresh.");
          process.exit(0);
        }

        const signals = await computeWorkspaceSignals(db, workspaceId, { testsPassed: options.testsPassed });
        const result = await proposeTransition(db, {
          workspaceId,
          toNodeName: options.to,
          summary: options.summary,
          triggeredBy: "agent",
          signals,
        });
        if (!result.ok) {
          console.error(`Transition failed: ${result.error ?? "unknown error"}`);
          process.exit(1);
        }
        const next = (result.nextTransitions ?? []).map((t) => t.toNodeName);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, action: "propose", movedTo: result.toNode?.name, autoRouted: result.autoResolved ?? false, status: result.statusName, terminal: next.length === 0, nextStages: next }, null, 2));
          process.exit(0);
        }
        console.log(`Proposed transition for workspace '${workspaceId}'.`);
        if (result.toNode?.name) console.log(`  movedTo: ${result.toNode.name}`);
        if (result.statusName) console.log(`  status: ${result.statusName}`);
        console.log(next.length === 0 ? "  terminal: workflow complete" : `  nextStages: ${next.join(", ")}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("analyze-touched <issue-id>")
    .description("Predict which source files an issue will likely modify.\n\nUses a fast AI model for analysis. Results are cached on the issue. Requires the kanban server to be running (pnpm dev).")
    .option("--refresh", "Force re-analysis even if a cached result exists")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace analyze-touched <issue-id>
  $ agentic-kanban workspace analyze-touched <issue-id> --refresh
  $ agentic-kanban workspace analyze-touched <issue-id> --json
`)
    .action(async (issueId: string, options: { refresh?: boolean; json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildApiUrl(port, `/api/issues/${encodeURIComponent(issueId)}/analyze-touched-files`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh: options.refresh ?? false }),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Analyze failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (Array.isArray(data.files)) {
            console.log(`Predicted touched files (${(data.files as string[]).length}):`);
            for (const f of data.files as string[]) console.log(`  ${f}`);
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("terminal <workspace-id>")
    .description("Read agent session output (terminal messages) for a workspace.\n\nReturns the last N messages, stripped of ANSI codes. Requires the kanban server to be running (pnpm dev).")
    .option("--limit <n>", "Number of most recent messages to return (default: 200, max: 2000)", "200")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace terminal <workspace-id>
  $ agentic-kanban workspace terminal <workspace-id> --limit 50
  $ agentic-kanban workspace terminal <workspace-id> --json
`)
    .action(async (workspaceId: string, options: { limit?: string; json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const limit = options.limit ?? "200";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "terminal"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: Number(limit) }),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Terminal failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.sessionStatus) console.log(`Session status: ${data.sessionStatus}`);
          if (data.totalMessages !== undefined) console.log(`Messages: ${data.returned ?? "?"} of ${data.totalMessages}`);
          if (Array.isArray(data.messages)) {
            for (const msg of data.messages as Array<{ type: string; data?: string; exitCode?: number }>) {
              if (msg.type === "stdout" && msg.data) process.stdout.write(msg.data);
              else if (msg.type === "exit") console.log(`[exit: ${msg.exitCode ?? "?"}]`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("comment-list <workspace-id>")
    .description("List diff review comments for a workspace.\n\nOptionally filter by file path. Requires the kanban server to be running (pnpm dev).")
    .option("--file <filePath>", "Filter comments by file path")
    .option("--json", "Output raw JSON response")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace comment-list <workspace-id>
  $ agentic-kanban workspace comment-list <workspace-id> --file src/index.ts
  $ agentic-kanban workspace comment-list <workspace-id> --json
`)
    .action(async (workspaceId: string, options: { file?: string; json?: boolean; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const url = options.file
          ? buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/comments?filePath=${encodeURIComponent(options.file)}`)
          : buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/comments`);
        const res = await fetch(url);
        const data = await res.json() as unknown;

        if (!res.ok) {
          console.error(`Comment list failed: ${(data as Record<string, unknown>).error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const comments = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
          if (comments.length === 0) {
            console.log("No comments found.");
          } else {
            console.log(`${comments.length} comment(s):`);
            for (const c of comments) {
              console.log(`  [${c.id}] ${c.filePath}:${c.lineNumNew ?? c.lineNumOld ?? "?"} — ${c.body}`);
              if (c.resolvedAt) console.log(`    (resolved at ${c.resolvedAt})`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("comment-add <workspace-id>")
    .description("Add a review comment on a file in a workspace's diff.\n\nRequires the kanban server to be running (pnpm dev).")
    .option("--file <filePath>", "File path the comment is on (required)")
    .option("--body <text>", "Comment text (required)")
    .option("--line <n>", "Line number on the new side of the diff")
    .option("--line-old <n>", "Line number on the old (base) side of the diff")
    .option("--side <side>", "Which side of the diff: new or old (default: new)", "new")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace comment-add <workspace-id> --file src/index.ts --line 42 --body "Consider extracting this"
  $ agentic-kanban workspace comment-add <workspace-id> --file src/index.ts --body "General file comment"
`)
    .action(async (workspaceId: string, options: { file?: string; body?: string; line?: string; lineOld?: string; side?: string; port?: string }) => {
      try {
        if (!options.file) {
          console.error("--file is required");
          process.exit(1);
        }
        if (!options.body) {
          console.error("--body is required");
          process.exit(1);
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const payload: Record<string, unknown> = {
          filePath: options.file,
          body: options.body,
          side: options.side ?? "new",
        };
        if (options.line !== undefined) payload.lineNumNew = Number(options.line);
        if (options.lineOld !== undefined) payload.lineNumOld = Number(options.lineOld);

        const res = await fetch(buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/comments`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Comment add failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Added comment on '${options.file}'`);
        console.log(`  id: ${data.id}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("handoff-bundle <workspace-id>")
    .description("Export a compact handoff bundle for a workspace.\n\nReturns workspace metadata, issue context, diff stats, agent summary, changed files, errors, and reviewer notes. Useful for stuck, awaiting-review, or human-transferred workspaces. Requires the kanban server to be running (pnpm dev).")
    .option("--format <format>", "Output format: json or markdown (default: json)", "json")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace handoff-bundle <workspace-id>
  $ agentic-kanban workspace handoff-bundle <workspace-id> --format markdown
`)
    .action(async (workspaceId: string, options: { format?: string; port?: string }) => {
      try {
        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const fmt = options.format === "markdown" ? "?format=markdown" : "";
        const res = await fetch(buildApiUrl(port, `/api/workspaces/${encodeURIComponent(workspaceId)}/handoff-bundle${fmt}`));

        if (!res.ok) {
          let errorText = res.statusText;
          try {
            const errData = await res.json() as Record<string, unknown>;
            errorText = String(errData.error ?? res.statusText);
          } catch { /* ignore */ }
          console.error(`Handoff bundle failed: ${errorText}`);
          process.exit(1);
        }

        const text = await res.text();
        console.log(text);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("approve-tool <workspace-id>")
    .description("Create a pending tool-use approval request for a workspace session.\n\nRoutes the approval request to the agentic-kanban UI for user approval. Used by the approve_tool_use MCP tool flow. Requires the kanban server to be running (pnpm dev).")
    .option("--tool <toolName>", "The tool name to request approval for (required)")
    .option("--input <json>", "JSON-encoded tool input (default: {})", "{}")
    .option("--session <sessionId>", "The session ID requesting approval")
    .option("-p, --port <port>", "Server port (default: $KANBAN_SERVER_PORT or 3001)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban workspace approve-tool <workspace-id> --tool bash --input '{"command":"ls"}'
  $ agentic-kanban workspace approve-tool <workspace-id> --tool file_write --session <session-id>
`)
    .action(async (workspaceId: string, options: { tool?: string; input?: string; session?: string; port?: string }) => {
      try {
        if (!options.tool) {
          console.error("--tool is required");
          process.exit(1);
        }

        let toolInput: unknown = {};
        try {
          toolInput = JSON.parse(options.input ?? "{}");
        } catch {
          console.error("--input must be valid JSON");
          process.exit(1);
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildApiUrl(port, "/api/approvals"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: options.session ?? workspaceId,
            toolName: options.tool,
            toolInput,
          }),
        });
        const data = await res.json() as Record<string, unknown>;

        if (!res.ok) {
          console.error(`Approve-tool failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Created approval request`);
        console.log(`  id: ${data.id}`);
        console.log(`  tool: ${options.tool}`);
        console.log(`  Check the board UI to approve or deny.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
