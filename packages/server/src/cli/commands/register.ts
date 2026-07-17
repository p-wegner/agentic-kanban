import type { Command } from "commander";
import { DEFAULT_STATUSES } from "../../repositories/issue.repository.js";
import { runMigrations, logDefaultBranch } from "../shared.js";
import { registerProject } from "../../services/project-registration.js";

export function registerRegisterCommand(program: Command) {
  program
    .command("register")
    .description("Register a git repo as a project.\n\nAuto-detects repo name, default branch, and remote URL from the git repo at <path>. Creates the default statuses (Backlog, Todo, In Progress, In Review, AI Reviewed, Done, Cancelled) and sets the project as the active project.\n\nIf the repo is already registered (same path), it skips without error.")
    .argument("[path]", "Path to the git repository")
    .option("-n, --name <name>", "Custom project name (defaults to repo directory name)")
    .option("--clone <url>", "Clone this git URL into the repos root (KANBAN_REPOS_DIR or <data dir>/repos) and register the clone")
    .addHelpText("after", `
Examples:
  $ agentic-kanban register .                 # register current directory
  $ agentic-kanban register /path/to/my-repo  # register a specific repo
  $ agentic-kanban register . --name "My App" # custom project name
  $ agentic-kanban register --clone https://github.com/user/repo.git
`)
    .action(async (path: string | undefined, options: { name?: string; clone?: string }) => {
      try {
        if (!path && !options.clone) {
          console.error("Error: provide a <path> or --clone <url>");
          process.exit(1);
        }
        if (path && options.clone) {
          console.error("Error: provide either <path> or --clone <url>, not both");
          process.exit(1);
        }
        await runMigrations();

        if (options.clone) {
          const { cloneRepo } = await import("../../services/repo-clone.service.js");
          path = await cloneRepo(options.clone, { name: options.name });
          console.log(`Cloned ${options.clone} to ${path}`);
        }

        // ONE registration path (#43): insert + statuses + scaffolding + derived config all
        // live in registerProject(), so a new registration-time step can never again be wired
        // into just one entry point (that was #37).
        //
        // awaitEnrichment (#42): the optional LLM gap-fill only fires for a marker-sparse repo,
        // and this process calls process.exit(0) immediately — a backgrounded promise (what the
        // server does) would be silently dropped and the profile would stay rule-based forever,
        // since repairProjectRegistration() only backfills a profile that is entirely ABSENT.
        // So the CLI awaits it, and onProgress explains the pause rather than looking like a hang.
        const { project, created, setupScript, verifyScript } = await registerProject(path!, {
          name: options.name,
          awaitEnrichment: true,
          onProgress: (message) => console.log(message),
        });

        if (!created) {
          console.log(`Project "${project.name}" already registered at ${project.repoPath}`);
          process.exit(0);
        }

        console.log(`Registered project "${project.name}"`);
        console.log(`  Repo: ${project.repoPath}`);
        logDefaultBranch(project.defaultBranch);
        if (project.remoteUrl) {
          console.log(`  Remote: ${project.remoteUrl}`);
        }
        console.log(`  Statuses: ${DEFAULT_STATUSES.map((s) => s.name).join(", ")}`);
        if (setupScript) {
          console.log(`  Setup script: ${setupScript}`);
        }
        if (verifyScript) {
          console.log(`  Verify command: ${verifyScript}`);
        }
        console.log(`  Set as active project.`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
