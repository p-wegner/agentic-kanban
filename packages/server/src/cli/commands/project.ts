import type { Command } from "commander";
import { getProjectByName, getProjectById, getAllProjects, deleteProjectCascade } from "../../repositories/project.repository.js";
import { getClosedWorkspaces } from "../../repositories/workspace.repository.js";
import { getPreference } from "../../repositories/preferences.repository.js";
import { runMigrations } from "../shared.js";

export function registerProjectCommands(program: Command) {
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

        const project = (await getProjectByName(nameOrId)) ?? (await getProjectById(nameOrId));
        if (!project) {
          console.error(`Project "${nameOrId}" not found.`);
          process.exit(1);
        }

        await deleteProjectCascade(project.id);

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

        const allProjects = await getAllProjects(undefined, { includeArchived: true });

        if (allProjects.length === 0) {
          console.log("No projects registered.");
          console.log('Run `pnpm cli -- register <path>` to register a git repo.');
          process.exit(0);
        }

        const activeId = await getPreference("activeProjectId");

        for (const p of allProjects) {
          const marker = p.id === activeId ? " (active)" : "";
          console.log(`  ${p.name}${marker}`);
          console.log(`    Path: ${p.repoPath}`);
          console.log(`    Branch: ${p.defaultBranch ?? "(unset)"}`);
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

        const closedWorkspaces = await getClosedWorkspaces();

        const withWorktrees = closedWorkspaces.filter((ws) => ws.workingDir);

        if (withWorktrees.length === 0) {
          console.log("No stale worktrees found.");
          process.exit(0);
        }

        console.log(`Found ${withWorktrees.length} closed workspace(s) with worktrees:`);
        for (const ws of withWorktrees) {
          console.log(`  ${ws.branch} -> ${ws.workingDir}`);
        }
        console.log("\nThese worktrees can be removed manually with:");
        console.log("  git worktree remove --force <path>");
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
