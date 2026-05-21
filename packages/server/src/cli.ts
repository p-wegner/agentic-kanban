#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import { db } from "./db/index.js";
import { projects, projectStatuses, preferences, workspaces, issues, issueTags, sessions, sessionMessages, agentSkills, issueDependencies, DEPENDENCY_TYPES } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, and, isNull, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { detectRepoInfo } from "./services/git-info.service.js";
import { getMigrationsFolder } from "./db/migrations.js";
import { parseSessionSummary, formatDurationStr } from "@agentic-kanban/shared";

const DEFAULT_STATUSES = [
  { name: "Todo", sortOrder: 0, isDefault: true },
  { name: "In Progress", sortOrder: 1, isDefault: false },
  { name: "In Review", sortOrder: 2, isDefault: false },
  { name: "AI Reviewed", sortOrder: 3, isDefault: false },
  { name: "Done", sortOrder: 4, isDefault: false },
  { name: "Cancelled", sortOrder: 5, isDefault: false },
];

async function runMigrations() {
  await migrate(db, { migrationsFolder: getMigrationsFolder() });
}

const program = new Command();

program
  .name("agentic-kanban")
  .description("CLI for managing agentic-kanban projects")
  .version(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")).version)
  .usage("<command> [options]")
  .addHelpText("after", `
Examples:
  $ agentic-kanban create my-app --path /projects    # create new repo and register it
  $ agentic-kanban register .                        # register existing repo
  $ agentic-kanban issue list -s Todo                # list todo issues
  $ agentic-kanban issue create "Fix login bug"      # create an issue
  $ agentic-kanban workspace create <issue-id>       # create a worktree for an issue
  $ agentic-kanban status                            # show board overview
  $ agentic-kanban skill list                        # list agent skills
  $ agentic-kanban preferences set projects_base_path /path/to/projects
`);

program
  .command("register")
  .description("Register a git repo as a project.\n\nAuto-detects repo name, default branch, and remote URL from the git repo at <path>. Creates 6 default statuses (Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as the active project.\n\nIf the repo is already registered (same path), it skips without error.")
  .argument("<path>", "Path to the git repository")
  .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
  .addHelpText("after", `
Examples:
  $ agentic-kanban register .                 # register current directory
  $ agentic-kanban register /path/to/my-repo  # register a specific repo
  $ agentic-kanban register . --name "My App" # custom project name
`)
  .action(async (path: string, options: { name?: string }) => {
    try {
      await runMigrations();

      const repoInfo = await detectRepoInfo(path);
      const projectName = options.name || repoInfo.repoName;

      // Check if a project with this repo path already exists
      const existing = await db
        .select()
        .from(projects)
        .where(eq(projects.repoPath, repoInfo.repoPath))
        .limit(1);

      if (existing.length > 0) {
        console.log(`Project "${existing[0].name}" already registered at ${repoInfo.repoPath}`);
        process.exit(0);
      }

      const now = new Date().toISOString();
      const projectId = randomUUID();

      await db.insert(projects).values({
        id: projectId,
        name: projectName,
        repoPath: repoInfo.repoPath,
        repoName: repoInfo.repoName,
        defaultBranch: repoInfo.defaultBranch,
        remoteUrl: repoInfo.remoteUrl,
        createdAt: now,
        updatedAt: now,
      });

      for (const status of DEFAULT_STATUSES) {
        await db.insert(projectStatuses).values({
          id: randomUUID(),
          projectId,
          name: status.name,
          sortOrder: status.sortOrder,
          isDefault: status.isDefault,
          createdAt: now,
        });
      }

      // Set as active project
      await db
        .insert(preferences)
        .values({
          key: "activeProjectId",
          value: projectId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: preferences.key,
          set: { value: projectId, updatedAt: now },
        });

      console.log(`Registered project "${projectName}"`);
      console.log(`  Repo: ${repoInfo.repoPath}`);
      console.log(`  Branch: ${repoInfo.defaultBranch}`);
      if (repoInfo.remoteUrl) {
        console.log(`  Remote: ${repoInfo.remoteUrl}`);
      }
      console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
      console.log(`  Set as active project.`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("create")
  .description("Create a new git repo and register it as a project.\n\nCreates a directory under the configured projects_base_path preference (or --path), runs 'git init', and registers the repo.\n\nUse 'pnpm cli -- register <path>' to register an existing repo instead.")
  .argument("<folder-name>", "Name of the new project folder to create")
  .option("--path <base-path>", "Base directory to create the folder in (overrides projects_base_path preference)")
  .option("-n, --name <name>", "Custom project name (defaults to folder name)")
  .option("-b, --branch <branch>", "Initial branch name (default: main)")
  .addHelpText("after", `
Examples:
  $ agentic-kanban create my-app                        # uses projects_base_path preference
  $ agentic-kanban create my-app --path /projects       # create in /projects/my-app
  $ agentic-kanban create my-app -n "My Application"   # custom project name
  $ agentic-kanban create my-app -b master              # use 'master' as initial branch

Setup:
  Set the base folder preference first:
  $ agentic-kanban preferences set projects_base_path /path/to/projects
`)
  .action(async (folderName: string, options: { path?: string; name?: string; branch?: string }) => {
    try {
      await runMigrations();

      // Resolve base folder: --path flag takes precedence over preference
      let baseFolder = options.path;
      if (!baseFolder) {
        const pref = await db.select().from(preferences).where(eq(preferences.key, "projects_base_path")).limit(1);
        if (pref.length > 0 && pref[0].value) {
          baseFolder = pref[0].value;
        }
      }

      if (!baseFolder) {
        console.error("No base folder configured. Use --path <base-path> or set the projects_base_path preference:");
        console.error("  pnpm cli -- preferences set projects_base_path /path/to/projects");
        process.exit(1);
      }

      const { mkdir, access, rm } = await import("node:fs/promises");
      const { join, resolve: resolvePath, sep } = await import("node:path");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      const resolvedBase = resolvePath(baseFolder);
      const repoPath = resolvePath(join(resolvedBase, folderName));

      // Guard against path traversal (e.g. folderName = "../../etc")
      if (!repoPath.startsWith(resolvedBase + sep) && repoPath !== resolvedBase) {
        console.error(`Invalid folder name: "${folderName}" escapes the base directory.`);
        process.exit(1);
      }

      // Check if directory already exists
      try {
        await access(repoPath);
        console.error(`Directory already exists: ${repoPath}`);
        process.exit(1);
      } catch {
        // Expected: directory doesn't exist yet
      }

      // Create directory -- track so we can clean up on failure
      await mkdir(repoPath, { recursive: true });
      let dirCreated = true;

      const cleanupDir = async () => {
        if (dirCreated) {
          try { await rm(repoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      };

      // Run git init
      const branch = options.branch ?? "main";
      try {
        await execFileAsync("git", ["-C", repoPath, "init", `-b`, branch]);
      } catch {
        // Older git versions don't support -b; fall back and rename
        await execFileAsync("git", ["-C", repoPath, "init"]);
        try {
          await execFileAsync("git", ["-C", repoPath, "checkout", "-b", branch]);
        } catch {
          // Branch may already be correct, ignore
        }
      }

      // Create an initial empty commit so the repo has a HEAD.
      // git commit requires user.name/email to be configured; give a clear error if not.
      try {
        await execFileAsync("git", ["-C", repoPath, "commit", "--allow-empty", "-m", "Initial commit"]);
      } catch (commitErr) {
        await cleanupDir();
        const msg = commitErr instanceof Error ? commitErr.message : String(commitErr);
        if (msg.includes("Please tell me who you are") || msg.includes("user.email") || msg.includes("user.name")) {
          console.error("git commit failed: git user identity not configured.");
          console.error("  Run: git config --global user.email \"you@example.com\"");
          console.error("       git config --global user.name \"Your Name\"");
        } else {
          console.error("git commit failed:", msg);
        }
        process.exit(1);
      }
      // Register the new repo
      const { detectRepoInfo: detectInfo } = await import("./services/git-info.service.js");
      const repoInfo = await detectInfo(repoPath);
      const projectName = options.name || folderName;

      // Check if already registered (shouldn't be, but be safe)
      const existing = await db.select().from(projects).where(eq(projects.repoPath, repoInfo.repoPath)).limit(1);
      if (existing.length > 0) {
        console.log(`Project "${existing[0].name}" already registered at ${repoInfo.repoPath}`);
        process.exit(0);
      }

      const now = new Date().toISOString();
      const projectId = randomUUID();

      await db.insert(projects).values({
        id: projectId,
        name: projectName,
        repoPath: repoInfo.repoPath,
        repoName: repoInfo.repoName,
        defaultBranch: repoInfo.defaultBranch,
        remoteUrl: repoInfo.remoteUrl,
        createdAt: now,
        updatedAt: now,
      });

      for (const status of DEFAULT_STATUSES) {
        await db.insert(projectStatuses).values({
          id: randomUUID(),
          projectId,
          name: status.name,
          sortOrder: status.sortOrder,
          isDefault: status.isDefault,
          createdAt: now,
        });
      }

      await db
        .insert(preferences)
        .values({ key: "activeProjectId", value: projectId, updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value: projectId, updatedAt: now } });

      dirCreated = false; // DB registration succeeded; keep the directory
      console.log(`Created and registered project "${projectName}"`);
      console.log(`  Path: ${repoInfo.repoPath}`);
      console.log(`  Branch: ${repoInfo.defaultBranch}`);
      console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
      console.log(`  Set as active project.`);
      process.exit(0);
    } catch (err) {
      await cleanupDir();
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const prefCmd = program
  .command("preferences")
  .description("Manage CLI preferences.\n\nSubcommands: get, set")
  .addHelpText("after", `
Examples:
  $ agentic-kanban preferences get projects_base_path
  $ agentic-kanban preferences set projects_base_path /path/to/projects
`);

prefCmd
  .command("set <key> <value>")
  .description("Set a preference value.")
  .action(async (key: string, value: string) => {
    try {
      await runMigrations();
      const now = new Date().toISOString();
      await db
        .insert(preferences)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: preferences.key, set: { value, updatedAt: now } });
      console.log(`Set ${key} = ${value}`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

prefCmd
  .command("get <key>")
  .description("Get a preference value.")
  .action(async (key: string) => {
    try {
      await runMigrations();
      const rows = await db.select().from(preferences).where(eq(preferences.key, key)).limit(1);
      if (rows.length === 0) {
        console.log(`(not set)`);
      } else {
        console.log(rows[0].value);
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("unregister")
  .description("Remove a registered project by name or ID.\n\nCascading deletes all associated data: issues, workspaces, sessions, issue tags, and project statuses.")
  .argument("<name-or-id>", "Project name or ID")
  .addHelpText("after", `
Examples:
  $ agentic-kanban unregister "My App"
  $ agentic-kanban unregister 180b7363-24d4-4ce8-be11-1e6212dabbfd
`)
  .action(async (nameOrId: string) => {
    try {
      await runMigrations();

      // Try to find by name first, then by ID
      let rows = await db
        .select()
        .from(projects)
        .where(eq(projects.name, nameOrId))
        .limit(1);

      if (rows.length === 0) {
        rows = await db
          .select()
          .from(projects)
          .where(eq(projects.id, nameOrId))
          .limit(1);
      }

      if (rows.length === 0) {
        console.error(`Project "${nameOrId}" not found.`);
        process.exit(1);
      }

      const project = rows[0];
      const projectId = project.id;

      // Cascade delete: find all issues for this project
      const projectIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.projectId, projectId));

      if (projectIssues.length > 0) {
        const issueIds = projectIssues.map((i) => i.id);

        // Delete issue tags
        await db.delete(issueTags).where(inArray(issueTags.issueId, issueIds));

        // Find and cleanup workspaces for these issues
        const wsRows = await db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(inArray(workspaces.issueId, issueIds));

        if (wsRows.length > 0) {
          const wsIds = wsRows.map((w) => w.id);
          // Delete sessions for these workspaces
          await db.delete(sessions).where(inArray(sessions.workspaceId, wsIds));
          // Delete workspaces
          await db.delete(workspaces).where(inArray(workspaces.id, wsIds));
        }

        // Delete issues
        await db.delete(issues).where(inArray(issues.id, issueIds));
      }

      // Delete project statuses
      await db.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));

      // Delete project
      await db.delete(projects).where(eq(projects.id, projectId));

      console.log(`Unregistered project "${project.name}" (${project.id})`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("list")
  .description("List all registered projects.\n\nShows project name, repo path, default branch, and remote URL. The active project is marked with (active).")
  .addHelpText("after", `
Example:
  $ agentic-kanban list
`)
  .action(async () => {
    try {
      await runMigrations();

      const allProjects = await db.select().from(projects);

      if (allProjects.length === 0) {
        console.log("No projects registered.");
        console.log('Run `pnpm cli -- register <path>` to register a git repo.');
        process.exit(0);
      }

      // Get active project
      const activePref = await db
        .select()
        .from(preferences)
        .where(eq(preferences.key, "activeProjectId"))
        .limit(1);
      const activeId = activePref.length > 0 ? activePref[0].value : null;

      for (const p of allProjects) {
        const marker = p.id === activeId ? " (active)" : "";
        console.log(`  ${p.name}${marker}`);
        console.log(`    Path: ${p.repoPath}`);
        console.log(`    Branch: ${p.defaultBranch}`);
        if (p.remoteUrl) {
          console.log(`    Remote: ${p.remoteUrl}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("cleanup")
  .description("Show stale worktrees for closed workspaces.\n\nLists git worktrees belonging to closed/merged workspaces. These worktrees are no longer needed and can be removed manually with 'git worktree remove --force <path>'.\n\nThis command does NOT auto-remove worktrees -- it only reports them.")
  .addHelpText("after", `
Example:
  $ agentic-kanban cleanup
  # Then manually remove with:
  $ git worktree remove --force <path>
`)
  .action(async () => {
    try {
      await runMigrations();

      const closedWorkspaces = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.status, "closed"));

      const withWorktrees = closedWorkspaces.filter((ws) => ws.workingDir);

      if (withWorktrees.length === 0) {
        console.log("No stale worktrees found.");
        process.exit(0);
      }

      console.log(`Found ${withWorktrees.length} closed workspace(s) with worktrees:`);
      for (const ws of withWorktrees) {
        console.log(`  ${ws.branch} ->' ${ws.workingDir}`);
      }
      console.log("\nThese worktrees can be removed manually with:");
      console.log("  git worktree remove --force <path>");
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

function timeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

program
  .command("status")
  .description("Show board status overview with all active agents, workspaces, and progress.\n\nDisplays a summary of issues, their workspace/session state, diff stats, token usage, and last agent output. By default only shows active (non-completed) issues.")
  .option("-p, --project <id>", "Project ID (defaults to active project)")
  .option("-a, --all", "Include closed/done issues", false)
  .option("--json", "Output raw JSON instead of formatted text")
  .option("-w, --watch", "Auto-refresh display at regular intervals")
  .option("-i, --interval <seconds>", "Refresh interval in seconds (default: 5, minimum: 2)", "5")
  .addHelpText("after", `
Examples:
  $ agentic-kanban status                       # active issues only
  $ agentic-kanban status --all                 # include completed issues
  $ agentic-kanban status --json                # machine-readable output
  $ agentic-kanban status --watch               # auto-refresh every 5s
  $ agentic-kanban status -w -i 10              # auto-refresh every 10s

Status indicators:
  * = active workspace   o = idle workspace   o = reviewing   . = no workspace
`)
  .action(async (options: { project?: string; all?: boolean; json?: boolean; watch?: boolean; interval?: string }) => {
    try {
      await runMigrations();
      const { getBoardStatus } = await import("./services/board-status.js");

      const render = async () => {
        const status = await getBoardStatus({
          projectId: options.project,
          includeClosed: options.all,
          tailLines: 5,
        });

        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }

        console.log(`\n  Board Status: ${status.project.name}`);
        console.log(`  ${status.totals.totalIssues} issues (${status.totals.inProgress} in-progress) | ${status.totals.activeWorkspaces} active workspaces | ${status.totals.runningSessions} running sessions`);
        console.log(`  Generated: ${new Date(status.generatedAt).toLocaleTimeString()}\n`);

        if (status.issues.length === 0) {
          console.log("  No active issues found. Use --all to include completed items.");
          return;
        }

        for (const issue of status.issues) {
          const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "???";
          const wsStatus = issue.workspace?.status ?? "no workspace";
          const marker = wsStatus === "active" ? "*" : wsStatus === "idle" ? "o" : wsStatus === "reviewing" ? "o" : ".";
          console.log(`  ${marker} ${num.padEnd(4)} ${issue.title}`);
          console.log(`         [${issue.statusName}]  priority: ${issue.priority}  workspace: ${wsStatus}`);

          if (issue.workspace) {
            console.log(`         branch: ${issue.workspace.branch}`);
          }

          if (issue.session) {
            console.log(`         session: ${issue.session.status}  started: ${issue.session.startedAt ? new Date(issue.session.startedAt).toLocaleTimeString() : "?"}`);
          }

          if (issue.diffStats && (issue.diffStats.filesChanged > 0 || issue.diffStats.insertions > 0 || issue.diffStats.deletions > 0)) {
            console.log(`         diff: ${issue.diffStats.filesChanged} files  +${issue.diffStats.insertions} -${issue.diffStats.deletions}`);
          }

          if (issue.sessionStats) {
            const s = issue.sessionStats;
            const parts: string[] = [];
            if (s.model) parts.push(`model: ${s.model}`);
            if (s.numTurns > 0) parts.push(`turns: ${s.numTurns}`);
            if (s.totalCostUsd > 0) parts.push(`cost: $${s.totalCostUsd.toFixed(2)}`);
            if (s.durationMs > 0) parts.push(`duration: ${Math.round(s.durationMs / 1000)}s`);
            if (parts.length > 0) console.log(`         ${parts.join("  ")}`);
          }

          if (issue.sessionStats?.agentSummary) {
            const lines = issue.sessionStats.agentSummary.split("\n").slice(0, 8);
            console.log(`         agent summary:`);
            for (const line of lines) {
              console.log(`           ${line}`);
            }
            if (issue.sessionStats.agentSummary.split("\n").length > 8) {
              console.log(`           ...`);
            }
          } else if (issue.lastOutput.length > 0) {
            console.log(`         last output:`);
            for (const line of issue.lastOutput) {
              console.log(`           ${line}`);
            }
          }

          if (issue.lastActivity) {
            console.log(`         last activity: ${timeSince(new Date(issue.lastActivity))} ago`);
          }

          console.log("");
        }
      };

      if (options.watch) {
        const intervalSec = Math.max(parseInt(options.interval ?? "5", 10), 2);
        const renderAndClear = async () => {
          console.clear();
          await render();
          console.log(`\n  Refreshing every ${intervalSec}s. Press Ctrl+C to exit.`);
        };
        await renderAndClear();
        setInterval(renderAndClear, intervalSec * 1000);
      } else {
        await render();
        process.exit(0);
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

async function getActiveProjectId(): Promise<string> {
  const pref = await db.select().from(preferences).where(eq(preferences.key, "activeProjectId")).limit(1);
  if (pref.length === 0) throw new Error("No active project. Run `pnpm cli -- register <path>` first.");
  return pref[0].value;
}

// ?? issue commands ??
const issueCmd = program.command("issue").description("Manage issues on the board.\n\nSubcommands: list, create, move, summary, dependency");

issueCmd
  .command("list")
  .description("List issues for the active project.\n\nShows issue number, priority, status, and title. Filters can be combined.")
  .option("-s, --status <status>", "Filter by status name (e.g. Todo, 'In Progress', Done)")
  .option("-p, --priority <priority>", "Filter by priority (low, medium, high, critical)")
  .addHelpText("after", `
Examples:
  $ agentic-kanban issue list                        # all issues
  $ agentic-kanban issue list -s Todo                # only todo issues
  $ agentic-kanban issue list -p critical            # only critical priority
  $ agentic-kanban issue list -s "In Progress" -p high
`)
  .action(async (options: { status?: string; priority?: string }) => {
    try {
      await runMigrations();
      const projectId = await getActiveProjectId();

      let rows = await db
        .select({
          issueNumber: issues.issueNumber,
          id: issues.id,
          title: issues.title,
          priority: issues.priority,
          statusName: projectStatuses.name,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
        .where(eq(issues.projectId, projectId));

      if (options.status) rows = rows.filter((r) => r.statusName === options.status);
      if (options.priority) rows = rows.filter((r) => r.priority === options.priority);

      if (rows.length === 0) {
        console.log("No issues found.");
        process.exit(0);
      }

      for (const r of rows) {
        const num = r.issueNumber != null ? `#${r.issueNumber}` : "(no number)";
        console.log(`  ${num.padEnd(6)} [${r.priority.padEnd(8)}] [${r.statusName}] ${r.title}`);
        console.log(`         id: ${r.id}`);
      }
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
  .option("-s, --status <status>", "Initial status name (default: first project status, typically Todo)")
  .addHelpText("after", `
Examples:
  $ agentic-kanban issue create "Fix login bug"
  $ agentic-kanban issue create "Add dark mode" -d "Support theme switching" -p high
  $ agentic-kanban issue create "Hotfix" -p critical -s "In Progress"
`)
  .action(async (title: string, options: { description?: string; priority?: string; status?: string }) => {
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

      await db.update(issues).set({ statusId: target.id, updatedAt: new Date().toISOString() }).where(eq(issues.id, issueId));

      console.log(`Moved issue to '${statusName}'`);
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

      const completedSession = sessionRows.find(s => s.status === "completed" || s.status === "stopped")
        ?? sessionRows[0]
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

      // Formatted output
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

// ?? workspace commands ??
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
      const { createWorktree } = await import("./services/git.service.js");

      const branchName = options.branch ?? `workspace/${issueId.slice(0, 8)}`;
      const baseBranch = options.base ?? project.defaultBranch;
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

// ?? skill commands ??
program
  .command("delete-status <status-id>")
  .description("Delete a project status (fails if issues are linked to it)")
  .action(async (statusId: string) => {
    try {
      await runMigrations();
      const rows = await db.select().from(projectStatuses).where(eq(projectStatuses.id, statusId)).limit(1);
      if (rows.length === 0) {
        console.error(`Status "${statusId}" not found.`);
        process.exit(1);
      }
      const linked = await db.select({ id: issues.id }).from(issues).where(eq(issues.statusId, statusId)).limit(1);
      if (linked.length > 0) {
        console.error(`Cannot delete status "${rows[0].name}" -- it has linked issues. Move or delete those issues first.`);
        process.exit(1);
      }
      await db.delete(projectStatuses).where(eq(projectStatuses.id, statusId));
      console.log(`Deleted status "${rows[0].name}" (${statusId})`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

const skillCmd = program.command("skill").description("Manage agent skills.\n\nSkills are prompt templates that can be injected into agent context when creating workspaces. Built-in skills (board-navigator, code-review, dependency-analyzer, ticket-enhancer) are seeded on first run and cannot be modified.\n\nSkills can be global (available to all projects) or project-scoped.\n\nSubcommands: list, get, create, export");

skillCmd
  .command("list")
  .description("List agent skills.\n\nShows skill name, scope (global/project), model override, and description. Built-in skills are marked with [builtin].")
  .option("-p, --project <projectId>", "Filter to project-specific + global skills")
  .addHelpText("after", `
Examples:
  $ agentic-kanban skill list                         # all skills
  $ agentic-kanban skill list -p 180b7363-...         # project + global skills
`)
  .action(async (options: { project?: string }) => {
    try {
      await runMigrations();
      let rows;
      if (options.project) {
        rows = await db.select().from(agentSkills)
          .where(sql`${agentSkills.projectId} IS NULL OR ${agentSkills.projectId} = ${options.project}`)
          .orderBy(agentSkills.name);
      } else {
        rows = await db.select().from(agentSkills).orderBy(agentSkills.name);
      }
      if (rows.length === 0) {
        console.log("No agent skills found.");
        process.exit(0);
      }
      for (const s of rows) {
        const builtin = s.isBuiltin ? " [builtin]" : "";
        const model = s.model ? ` (model: ${s.model})` : "";
        const scope = s.projectId ? ` (project)` : " (global)";
        console.log(`  ${s.name}${builtin}${model}${scope}`);
        console.log(`    id: ${s.id}`);
        console.log(`    ${s.description}`);
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

skillCmd
  .command("get <name-or-id>")
  .description("Show full details of a skill including its prompt template.\n\nDisplays the skill name, ID, description, model override, scope, and the full prompt text. Useful for reviewing or debugging skill prompts.")
  .addHelpText("after", `
Examples:
  $ agentic-kanban skill get code-review
  $ agentic-kanban skill get abc123-def456-...
`)
  .action(async (nameOrId: string) => {
    try {
      await runMigrations();
      let rows = await db.select().from(agentSkills).where(eq(agentSkills.name, nameOrId)).limit(1);
      if (rows.length === 0) {
        rows = await db.select().from(agentSkills).where(eq(agentSkills.id, nameOrId)).limit(1);
      }
      if (rows.length === 0) {
        console.error(`Skill '${nameOrId}' not found.`);
        process.exit(1);
      }
      const s = rows[0];
      console.log(`Name: ${s.name}`);
      console.log(`ID: ${s.id}`);
      console.log(`Description: ${s.description}`);
      console.log(`Model: ${s.model ?? "default"}`);
      console.log(`Scope: ${s.projectId ? `project (${s.projectId})` : "global"}`);
      console.log(`Builtin: ${s.isBuiltin}`);
      console.log(`\n--- Prompt ---\n${s.prompt}`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

skillCmd
  .command("create <name>")
  .description("Create a new agent skill.\n\nCreates a custom prompt template that can be selected when creating a workspace. Skill names must be unique within their scope (global or same project). Names cannot contain '/', '\\', or '..'.")
  .option("-d, --description <description>", "Skill description (defaults to name)")
  .option("-p, --prompt <prompt>", "Skill prompt template text (defaults to 'No prompt provided.')")
  .option("-m, --model <model>", "Model override: haiku, sonnet, opus (default: no override)")
  .option("--project <projectId>", "Scope skill to a specific project (omit for global)")
  .addHelpText("after", `
Examples:
  $ agentic-kanban skill create my-reviewer -d "Custom code reviewer" -p "Review for..."
  $ agentic-kanban skill create quick-fix -m haiku -p "Apply quick fixes"
  $ agentic-kanban skill create project-skill --project 180b7363-... -p "Project-specific prompt"
`)
  .action(async (name: string, options: { description?: string; prompt?: string; model?: string; project?: string }) => {
    try {
      await runMigrations();
      if (/[\/\\]|\.\./.test(name)) {
        console.error("Skill name cannot contain '/', '\\', or '..'.");
        process.exit(1);
      }
      const scopeProjectId = options.project || null;
      // Check for duplicate name in same scope
      const scopeCondition = scopeProjectId
        ? and(eq(agentSkills.name, name), eq(agentSkills.projectId, scopeProjectId))
        : and(eq(agentSkills.name, name), isNull(agentSkills.projectId));
      const existing = await db.select().from(agentSkills).where(scopeCondition).limit(1);
      if (existing.length > 0) {
        console.error(`Skill '${name}' already exists in this scope.`);
        process.exit(1);
      }
      const prompt = options.prompt ?? "No prompt provided.";
      const description = options.description ?? name;
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.insert(agentSkills).values({
        id,
        name,
        description,
        prompt,
        model: options.model ?? null,
        projectId: scopeProjectId,
        isBuiltin: false,
        createdAt: now,
        updatedAt: now,
      });
      const scope = scopeProjectId ? ` (project: ${scopeProjectId})` : " (global)";
      console.log(`Created skill '${name}'${scope}`);
      console.log(`  id: ${id}`);
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

skillCmd
  .command("export <target-path>")
  .description("Export skills as SKILL.md files for Claude Code and Codex.\n\nWrites skills into the .claude/skills/ directory of the target project and links .codex/skills to the same directory. Each skill is written as <name>/SKILL.md with frontmatter.")
  .option("-p, --project <projectId>", "Export only project-specific + global skills")
  .option("-n, --names <names>", "Comma-separated list of skill names to export")
  .addHelpText("after", `
Examples:
  $ agentic-kanban skill export /path/to/my-project
  $ agentic-kanban skill export . -n "code-review,dependency-analyzer"
  $ agentic-kanban skill export . -p 180b7363-...
`)
  .action(async (targetPath: string, options: { project?: string; names?: string }) => {
    try {
      await runMigrations();
      const { access } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { ensureCodexSkillsLink, writeAgentSkillFile } = await import("@agentic-kanban/shared/lib/agent-skill-files");

      // Verify target path
      try {
        await access(targetPath);
      } catch {
        console.error(`Target path does not exist: ${targetPath}`);
        process.exit(1);
      }

      // Fetch skills
      let rows;
      if (options.project) {
        rows = await db.select().from(agentSkills)
          .where(sql`${agentSkills.projectId} IS NULL OR ${agentSkills.projectId} = ${options.project}`)
          .orderBy(agentSkills.name);
      } else {
        rows = await db.select().from(agentSkills).orderBy(agentSkills.name);
      }

      if (options.names) {
        const nameSet = new Set(options.names.split(",").map(n => n.trim()));
        rows = rows.filter(s => nameSet.has(s.name));
      }

      if (rows.length === 0) {
        console.log("No skills found to export.");
        process.exit(0);
      }

      const skillsDir = join(targetPath, ".claude", "skills");
      await ensureCodexSkillsLink(targetPath);

      for (const skill of rows) {
        if (/[\/\\]|\.\./.test(skill.name)) {
          console.warn(`  Skipping skill with unsafe name: ${skill.name}`);
          continue;
        }
        await writeAgentSkillFile(targetPath, skill);
      }

      console.log(`Exported ${rows.length} skill(s) to ${skillsDir} and linked .codex/skills to the same directory:`);
      for (const s of rows) {
        const scope = s.projectId ? "project" : "global";
        const builtin = s.isBuiltin ? " [builtin]" : "";
        console.log(`  - ${s.name} (${scope}${builtin})`);
      }
      process.exit(0);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ?? dependency commands ??
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

      // Outgoing: this issue depends on / relates to others
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

      // Incoming: others depend on / relate to this issue
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

program
  .command("dev")
  .description("Start the development server (server + built client UI)")
  .option("-p, --port <port>", "Server port", process.env.PORT || "3001")
  .option("--no-open", "Do not open browser")
  .action(async (options: { port: string; open: boolean }) => {
    try {
      const port = Number(options.port);
      process.env.PORT = String(port);

      const { startServer } = await import("./server-start.js");
      await startServer(port);

      console.log(`\n  Agentic Kanban running at http://localhost:${port}`);
      console.log("  Press Ctrl+C to stop\n");

      // Open browser
      if (options.open) {
        const { execFile } = await import("node:child_process");
        const cmd = process.platform === "win32" ? "cmd" : "open";
        const args = process.platform === "win32" ? ["/c", "start", `http://localhost:${port}`] : [`http://localhost:${port}`];
        execFile(cmd, args, (err) => {
          if (err) console.warn("  Could not open browser:", err.message);
        });
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ?? sessions debug command ??
const sessionDebugCmd = program
  .command("session-history [issue-number]")
  .alias("sh")
  .description(
    "Inspect Claude Code session transcript files from ~/.claude/projects/.\n\nParses JSONL session files for worktrees linked to this project's issues, showing what the agent did and why it stopped -- without loading entire large files."
  )
  .option("-t, --tail <lines>", "Number of tail lines to parse per session file (default: 60)", "60")
  .option("-a, --all", "Show all sessions for the issue, not just the latest", false)
  .option("--json", "Output raw JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ agentic-kanban session-history           # all issues with session dirs
  $ agentic-kanban sh 17                     # inspect issue #17 sessions
  $ agentic-kanban sh 23 --all               # all session files for #23
  $ agentic-kanban sh 17 --tail 100          # parse more lines for detail
  $ agentic-kanban sh --json                 # machine-readable output

Via pnpm (use -- to pass args):
  $ pnpm sh -- 17
  $ pnpm sh -- 17 --all
`
  )
  .action(
    async (issueArg: string | undefined, options: { tail?: string; all?: boolean; json?: boolean }) => {
      const issueNumber = issueArg;
      const { homedir } = await import("node:os");
      const { readdirSync, statSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");

      const claudeProjects = join(homedir(), ".claude", "projects");
      const tailLines = parseInt(options.tail ?? "60", 10);

      // Find all worktree session dirs for this project
      let allDirs: { name: string; path: string; issueNum: number | null }[] = [];
      try {
        const entries = readdirSync(claudeProjects);
        for (const entry of entries) {
          // Match C--andrena--worktrees-feature-ak-N-* and C--andrena-agentic-kanban-packages--worktrees-*
          const m =
            entry.match(/--worktrees-feature-ak-(\d+)-/i) ||
            entry.match(/agentic-kanban-packages--worktrees-feature-ak-(\d+)-/i);
          const issueNum = m ? parseInt(m[1], 10) : null;
          if (m || entry.includes("worktrees")) {
            allDirs.push({ name: entry, path: join(claudeProjects, entry), issueNum });
          }
        }
      } catch {
        console.error(`Cannot read ${claudeProjects}`);
        process.exit(1);
      }

      if (issueNumber) {
        const n = parseInt(issueNumber, 10);
        allDirs = allDirs.filter((d) => d.issueNum === n);
        if (allDirs.length === 0) {
          console.error(`No session directory found for issue #${n}`);
          process.exit(1);
        }
      }

      // Sort by issue number
      allDirs.sort((a, b) => (a.issueNum ?? 999) - (b.issueNum ?? 999));

      interface SessionResult {
        issueNum: number | null;
        dir: string;
        file: string;
        fileSizeBytes: number;
        lastModified: string;
        linesParsed: number;
        turns: number;
        lastAssistantText: string | null;
        lastToolCall: string | null;
        stopReason: string | null;
        sessionStarted: boolean;
        agentResponded: boolean;
        sessionId: string | null;
      }

      const results: SessionResult[] = [];

      for (const dir of allDirs) {
        // List .jsonl files in this dir, sort by mtime desc
        let jsonlFiles: { name: string; path: string; mtime: Date; size: number }[] = [];
        try {
          const files = readdirSync(dir.path).filter((f) => f.endsWith(".jsonl"));
          for (const f of files) {
            const fp = join(dir.path, f);
            const st = statSync(fp);
            jsonlFiles.push({ name: f, path: fp, mtime: st.mtime, size: st.size });
          }
          jsonlFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
        } catch {
          continue;
        }

        if (!options.all) jsonlFiles = jsonlFiles.slice(0, 1);

        for (const jf of jsonlFiles) {
          // Read only the tail -- avoid loading huge files
          const raw = readFileSync(jf.path, "utf8");
          const allLines = raw.split("\n").filter(Boolean);
          const tailStart = Math.max(0, allLines.length - tailLines);
          const linesToParse = allLines.slice(tailStart);

          let turns = 0;
          let lastAssistantText: string | null = null;
          let lastToolCall: string | null = null;
          let stopReason: string | null = null;
          let sessionStarted = false;
          let agentResponded = false;
          let sessionId: string | null = null;

          for (const line of linesToParse) {
            let obj: Record<string, unknown>;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }

            if (!sessionId && (obj.sessionId as string)) sessionId = obj.sessionId as string;

            const type = obj.type as string;
            if (type === "user") sessionStarted = true;

            if (type === "assistant") {
              agentResponded = true;
              const msg = obj.message as { role: string; stop_reason?: string; content?: unknown[] };
              if (msg.stop_reason) stopReason = msg.stop_reason;
              const content = msg.content ?? [];
              for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
                if (block.type === "text" && block.text) {
                  lastAssistantText = block.text.replace(/\s+/g, " ").slice(0, 300);
                  turns++;
                }
                if (block.type === "tool_use" && block.name) {
                  const inputStr = block.input ? JSON.stringify(block.input).slice(0, 80) : "";
                  lastToolCall = `${block.name}  ${inputStr}`;
                }
              }
            }
          }

          results.push({
            issueNum: dir.issueNum,
            dir: dir.name,
            file: jf.name.replace(".jsonl", "").slice(0, 8) + "--",
            fileSizeBytes: jf.size,
            lastModified: jf.mtime.toISOString(),
            linesParsed: linesToParse.length,
            turns,
            lastAssistantText,
            lastToolCall,
            stopReason,
            sessionStarted,
            agentResponded,
            sessionId: sessionId ? (sessionId as string).slice(0, 8) + "--" : null,
          });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
        process.exit(0);
      }

      // Formatted output
      console.log(`\n  Claude Session History  (tail: ${tailLines} lines/file)\n`);

      let currentIssue: number | null = -1;
      for (const r of results) {
        if (r.issueNum !== currentIssue) {
          currentIssue = r.issueNum;
          console.log(`  -- #${r.issueNum ?? "?"} ----------------------------------`);
        }
        const size = r.fileSizeBytes < 1024 ? `${r.fileSizeBytes}B` : `${(r.fileSizeBytes / 1024).toFixed(0)}KB`;
        const age = timeSince(new Date(r.lastModified));
        const started = r.sessionStarted ? (r.agentResponded ? "OK responded" : "FAIL no response") : "FAIL no prompt";
        console.log(`  ${r.file}  ${size}  ${age} ago  [${started}]  turns:${r.turns}`);
        if (r.stopReason) console.log(`    stop_reason: ${r.stopReason}`);
        if (r.lastToolCall) console.log(`    last tool:   ${r.lastToolCall}`);
        if (r.lastAssistantText) console.log(`    last text:   ${r.lastAssistantText.slice(0, 200)}`);
        console.log("");
      }

      if (results.length === 0) console.log("  No session files found.\n");

      process.exit(0);
    }
  );

void sessionDebugCmd;

program.parse();

