#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/index.js";
import { projects } from "@agentic-kanban/shared/schema";
import { registerRegisterCommand } from "./commands/register.js";
import { registerCreateCommand } from "./commands/create.js";
import { registerPreferencesCommand } from "./commands/preferences.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerIssueCommand } from "./commands/issue.js";
import { registerWorkspaceCommand } from "./commands/workspace.js";
import { registerWorkflowCommand } from "./commands/workflow.js";
import { registerSkillCommand } from "./commands/skill.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerButlerCommand } from "./commands/butler.js";
import { registerSystemCommands } from "./commands/system.js";
import { runMigrations, logDefaultBranch } from "./shared.js";

const program = new Command();

program
  .name("agentic-kanban")
  .description("CLI for managing agentic-kanban projects")
  .version(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")).version)
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

registerRegisterCommand(program);
registerCreateCommand(program);
registerPreferencesCommand(program);
registerProjectCommands(program);
registerStatusCommand(program);
registerIssueCommand(program);
registerWorkspaceCommand(program);
registerWorkflowCommand(program);
registerSkillCommand(program);
registerSessionCommand(program);
registerButlerCommand(program);
registerSystemCommands(program);

// ── `pnpm cli -- <args>` forwards a literal "--" as the first script argument.
// Commander treats a leading "--" as "end of options", so every token after it
// (including --help, --version, --json, -d) is parsed as a positional operand
// instead of a flag — which made `pnpm cli -- issue create --help` create an
// issue literally titled "--help", and broke --json through the wrapper. Strip a
// single leading "--" (the wrapper artifact) so flags work as written. A bare
// `pnpm cli --` then collapses to no args and starts the server, same as `pnpm cli`.
if (process.argv[2] === "--") {
  process.argv.splice(2, 1);
}

// ── Default action: the bare `agentic-kanban` invocation (no args) auto-inits,
// auto-registers the cwd repo, and starts the server. ANY args — a subcommand OR a
// flag like --help / --version — are handed to commander instead. (Previously this
// matched against a hand-maintained subcommand list, so --help/--version weren't
// recognized and wrongly fell through to starting the server.)
const hasArgs = process.argv.length > 2;

if (!hasArgs) {
  (async () => {
    try {
      const { dbExists, ensureDataDir } = await import("../db/data-dir.js");
      const { execFile } = await import("node:child_process");

      // Auto-init if no database
      if (!dbExists()) {
        console.log("First run — setting up agentic-kanban...\n");
        ensureDataDir();
        await runMigrations();
        console.log("  Database created and migrated.");
        const { seed } = await import("../db/seed.js");
        await seed();
        console.log("  Default tags and skills seeded.\n");
      } else {
        await runMigrations();
      }

      // Auto-register CWD if it's a git repo and no project exists yet
      const allProjects = await db.select().from(projects);
      if (allProjects.length === 0) {
        try {
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          await execFileAsync("git", ["-C", process.cwd(), "rev-parse", "--git-dir"]);
          // CWD is a git repo — register it
          const { registerProject } = await import("../services/project-registration.js");
          const { project, created } = await registerProject(process.cwd());
          if (created) {
            console.log(`  Registered project "${project.name}" (${project.repoPath})`);
            logDefaultBranch(project.defaultBranch);
            console.log("");
          }
        } catch {
          // Not a git repo — skip registration, user can do it manually
          console.log("  No project registered (current directory is not a git repo).");
          console.log("  Run `agentic-kanban register <path>` to register one.\n");
        }
      }

      // Start server
      const port = Number(process.env.PORT || 3001);
      const host = process.env.KANBAN_HOST || "127.0.0.1";
      process.env.PORT = String(port);
      process.env.KANBAN_HOST = host;

      const { startServer } = await import("../server-start.js");
      await startServer(port, host);

      // Show concise startup info
      console.log(`\n  Agentic Kanban is running\n`);
      console.log(`    UI:  http://${host}:${port}`);
      console.log(`    API: http://${host}:${port}/api/projects\n`);
      console.log("  Useful commands:");
      console.log("    agentic-kanban status              — board overview");
      console.log("    agentic-kanban issue create \"Title\" — create an issue");
      console.log("    agentic-kanban issue list           — list issues");
      console.log("    agentic-kanban register <path>      — register another repo");
      console.log("    agentic-kanban install-skill .       — write agent skills to cwd");
      console.log("    agentic-kanban --help                — all commands\n");
      console.log("  Press Ctrl+C to stop\n");

      // Open browser
      const cmd = process.platform === "win32" ? "cmd" : "open";
      const args = process.platform === "win32" ? ["/c", "start", `http://${host}:${port}`] : [`http://${host}:${port}`];
      execFile(cmd, args, (err) => {
        if (err) console.warn("  Could not open browser:", err.message);
      });
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  })();
} else {
  program.parse();
}
