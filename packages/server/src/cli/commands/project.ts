import type { Command } from "commander";
import { db } from "../../db/index.js";
import { projects, projectStatuses, preferences, workspaces, issues, issueTags, sessions } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
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

        const projectIssues = await db
          .select({ id: issues.id })
          .from(issues)
          .where(eq(issues.projectId, projectId));

        if (projectIssues.length > 0) {
          const issueIds = projectIssues.map((i) => i.id);

          await db.delete(issueTags).where(inArray(issueTags.issueId, issueIds));

          const wsRows = await db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(inArray(workspaces.issueId, issueIds));

          if (wsRows.length > 0) {
            const wsIds = wsRows.map((w) => w.id);
            await db.delete(sessions).where(inArray(sessions.workspaceId, wsIds));
            await db.delete(workspaces).where(inArray(workspaces.id, wsIds));
          }

          await db.delete(issues).where(inArray(issues.id, issueIds));
        }

        await db.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));
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
