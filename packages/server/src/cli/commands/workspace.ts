import type { Command } from "commander";
import { getIssueIdByNumberInProject } from "../../repositories/issue.repository.js";
import { getIssueById } from "../../repositories/followup-workspace.repository.js";
import { getProjectById } from "../../repositories/project.repository.js";
import { getWorkspaceById, getLatestWorkspaceForIssue } from "../../repositories/workspace.repository.js";
import { getWorkspacesForIssues } from "../../repositories/board-status.repository.js";
import { insertWorkspaceRecordRow } from "../../repositories/workspace-crud.repository.js";
import { getIssueTitleAndDescription } from "../../repositories/workspace-session.repository.js";
import { getProjectIssueIds } from "../../repositories/review-effectiveness.repository.js";
import { randomUUID } from "node:crypto";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { buildWorkspaceApiUrl, buildApiUrl } from "./workspace-api-url.js";
import { registerWorkspaceInteractionCommands } from "./workspace-interaction.js";

/** Shape of the error envelope every workspace action endpoint returns on failure. */
interface ErrorResponse {
  error?: string;
}

/** POST .../launch — session start. */
interface LaunchResponse extends ErrorResponse {
  sessionId?: string;
}

/** POST /api/workspaces — one-step create + launch. */
interface StartResponse extends ErrorResponse {
  id?: string;
  branch?: string;
  workingDir?: string;
}

/** GET .../diff — workspace git diff. */
interface DiffResponse extends ErrorResponse {
  stats?: string;
  changedFiles?: string[];
  diff?: string;
}

/** GET .../scorecard — PR quality scorecard. */
interface ScorecardResponse extends ErrorResponse {
  score?: number | null;
  computedAt?: string;
  dimensions?: Array<{ name: string; score: number; maxScore: number; signal: string }>;
}

/** POST .../merge — merge result. */
interface MergeResponse extends ErrorResponse {
  mergeOutput?: string;
}

/** POST .../close — close result. */
interface CloseResponse extends ErrorResponse {
  status?: string;
}

/** POST .../stop — stop running sessions. */
interface StopResponse extends ErrorResponse {
  sessionsStopped?: number | null;
}

/** POST .../ready-for-merge — mark ready result. */
interface MarkReadyResponse extends ErrorResponse {
  readyForMerge?: boolean;
}

/** POST .../transition — workflow transition result. */
interface TransitionResponse extends ErrorResponse {
  movedTo?: string;
  status?: string;
  nextStages?: string[];
}

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

        const projectIssues = await getProjectIssueIds(projectId);

        if (projectIssues.length === 0) {
          console.log("No workspaces found (no issues in active project).");
          process.exit(0);
        }

        const issueIds = projectIssues.map((i) => i.id);
        let rows = await getWorkspacesForIssues(issueIds);

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

        const issueRows = await getIssueById(issueId);
        if (issueRows.length === 0) {
          console.error(`Issue '${issueId}' not found.`);
          process.exit(1);
        }

        const project = await getProjectById(issueRows[0].projectId);
        if (!project || !project.repoPath) {
          console.error("Project has no repo path configured.");
          process.exit(1);
        }
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

        await insertWorkspaceRecordRow({
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

        const ws = await getWorkspaceById(workspaceId);
        if (!ws) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }
        let prompt = options.prompt;
        if (!prompt) {
          const detail = await getIssueTitleAndDescription(ws.issueId);
          if (detail) {
            prompt = detail.description
              ? `${detail.title}\n\n${detail.description}`
              : detail.title;
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
        const data = await res.json() as LaunchResponse;

        if (!res.ok) {
          console.error(`Launch failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Launched workspace '${workspaceId}'`);
        console.log(`  sessionId: ${String(data.sessionId)}`);
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

        const issueId = await getIssueIdByNumberInProject(num, projectId);
        if (issueId === null) {
          console.error(`Issue #${num} not found.`);
          process.exit(1);
        }

        const ws = await getLatestWorkspaceForIssue(issueId);
        if (!ws) {
          console.error(`No workspace found for issue #${num}. Create one first.`);
          process.exit(1);
        }
        let prompt = options.prompt;
        if (!prompt) {
          const detail = await getIssueTitleAndDescription(ws.issueId);
          if (detail) {
            prompt = detail.description
              ? `${detail.title}\n\n${detail.description}`
              : detail.title;
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
        const data = await res.json() as LaunchResponse;

        if (!res.ok) {
          console.error(`Resume failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Resumed #${num} (${ws.branch})`);
        console.log(`  workspace: ${ws.id}`);
        console.log(`  sessionId: ${String(data.sessionId)}`);
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

        if (!(await getWorkspaceById(workspaceId))) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }

        const port = options.port ?? process.env.KANBAN_SERVER_PORT ?? "3001";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "review"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json() as LaunchResponse;

        if (!res.ok) {
          console.error(`Review failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Review started for workspace '${workspaceId}'`);
        console.log(`  sessionId: ${String(data.sessionId)}`);
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
        const data = await res.json() as StartResponse;

        if (!res.ok) {
          console.error(`Start failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Started workspace for issue '${issueId}'`);
        console.log(`  id: ${String(data.id)}`);
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
        const data = await res.json() as DiffResponse;

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
            for (const f of data.changedFiles) console.log(`  ${f}`);
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
        const data = await res.json() as ScorecardResponse;

        if (!res.ok) {
          console.error(`Scorecard failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (data.score !== undefined) console.log(`Score: ${String(data.score)}/100`);
          if (data.computedAt) console.log(`Computed: ${data.computedAt}`);
          if (Array.isArray(data.dimensions)) {
            console.log("Dimensions:");
            for (const d of data.dimensions) {
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
        const data = await res.json() as MergeResponse;

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
        const data = await res.json() as CloseResponse;

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
        const data = await res.json() as StopResponse;

        if (!res.ok) {
          console.error(`Stop failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Stopped workspace '${workspaceId}'`);
        if (data.sessionsStopped !== undefined) console.log(`  sessions stopped: ${String(data.sessionsStopped)}`);
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

        const data = await res.json() as ErrorResponse;
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

        const ws = await getWorkspaceById(workspaceId);
        if (!ws) {
          console.error(`Workspace '${workspaceId}' not found.`);
          process.exit(1);
        }
        let prompt = options.prompt;
        if (!prompt) {
          const detail = await getIssueTitleAndDescription(ws.issueId);
          if (detail) {
            prompt = detail.description
              ? `${detail.title}\n\n${detail.description}`
              : detail.title;
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
        const data = await res.json() as LaunchResponse;

        if (!res.ok) {
          console.error(`Relaunch failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Relaunched workspace '${workspaceId}'`);
        console.log(`  sessionId: ${String(data.sessionId)}`);
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
        const data = await res.json() as MarkReadyResponse;

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
        const data = await res.json() as TransitionResponse;

        if (!res.ok) {
          console.error(`Transition failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Transitioned workspace '${workspaceId}'`);
        if (data.movedTo) console.log(`  movedTo: ${data.movedTo}`);
        if (data.status) console.log(`  status: ${data.status}`);
        if (Array.isArray(data.nextStages) && data.nextStages.length > 0) {
          console.log(`  nextStages: ${data.nextStages.join(", ")}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  registerWorkspaceInteractionCommands(wsCmd);
}
