import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { getProjectByName, getProjectById, getAllProjects, deleteProjectCascade } from "../../repositories/project.repository.js";
import { getClosedWorkspaces } from "../../repositories/workspace.repository.js";
import { getPreference } from "../../repositories/preferences.repository.js";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { unregisterLeakedTempProjects, findProjectsWithMissingRepoPath } from "../../services/project-registration.js";
import { exportBacklogSnapshot, importBacklogSnapshot, validateBacklogSnapshot } from "../../services/backlog-snapshot.service.js";

/** Resolve a project by name or id, defaulting to the active project when omitted. */
async function resolveProject(nameOrId: string | undefined) {
  if (nameOrId) {
    return (await getProjectByName(nameOrId)) ?? (await getProjectById(nameOrId));
  }
  return getProjectById(await getActiveProjectId());
}

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
    .command("export-backlog")
    .description("Export a project's full backlog (issues, statuses, tags, milestones, dependencies) as a portable JSON snapshot for moving between devices.\n\nExcludes device-specific data (workspaces, sessions, agent output). Writes to --out, or stdout if omitted.")
    .argument("[name-or-id]", "Project name or ID (defaults to the active project)")
    .option("-o, --out <file>", "Write the snapshot JSON to this file instead of stdout")
    .addHelpText("after", `
Examples:
  $ agentic-kanban export-backlog -o backlog.json
  $ agentic-kanban export-backlog agentic-kanban -o backlog.json
`)
    .action(async (nameOrId: string | undefined, opts: { out?: string }) => {
      try {
        await runMigrations();
        const project = await resolveProject(nameOrId);
        if (!project) {
          console.error(`Project "${nameOrId ?? "(active)"}" not found.`);
          process.exit(1);
        }
        const snapshot = await exportBacklogSnapshot(project.id);
        const json = JSON.stringify(snapshot, null, 2);
        if (opts.out) {
          writeFileSync(opts.out, json, "utf8");
          console.error(`Exported ${snapshot.issues.length} issue(s) from "${project.name}" to ${opts.out}`);
        } else {
          console.log(json);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command("import-backlog")
    .description("Import a backlog snapshot (from `export-backlog`) into a project.\n\nRemaps statuses/tags/milestones by name (creating any missing), preserves issue numbers when free (renumbering on collision), and rewires dependencies. Note: importing the same file twice duplicates issues.")
    .argument("<file>", "Path to the snapshot JSON file")
    .argument("[name-or-id]", "Target project name or ID (defaults to the active project)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban import-backlog backlog.json
  $ agentic-kanban import-backlog backlog.json agentic-kanban
`)
    .action(async (file: string, nameOrId: string | undefined) => {
      try {
        await runMigrations();
        const project = await resolveProject(nameOrId);
        if (!project) {
          console.error(`Project "${nameOrId ?? "(active)"}" not found.`);
          process.exit(1);
        }
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(file, "utf8"));
        } catch (e) {
          console.error(`Could not read/parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
          process.exit(1);
        }
        const { snapshot, errors } = validateBacklogSnapshot(raw);
        if (!snapshot) {
          console.error("Invalid snapshot:");
          for (const e of errors) console.error("  - " + e);
          process.exit(1);
        }
        const result = await importBacklogSnapshot(project.id, snapshot);
        console.log(`Imported into "${project.name}":`);
        console.log(`  issues:        ${result.createdIssues}`);
        console.log(`  dependencies:  ${result.createdDependencies}${result.skippedDependencies ? ` (${result.skippedDependencies} skipped)` : ""}`);
        if (result.createdStatuses.length) console.log(`  new statuses:  ${result.createdStatuses.join(", ")}`);
        if (result.createdTags.length) console.log(`  new tags:      ${result.createdTags.join(", ")}`);
        if (result.createdMilestones.length) console.log(`  new milestones: ${result.createdMilestones.join(", ")}`);
        for (const w of result.warnings) console.log(`  ! ${w}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  program
    .command("cleanup")
    .description("Show stale worktrees for closed workspaces, and clean up leaked temp-fixture project registrations.\n\nLists git worktrees belonging to closed/merged workspaces (remove manually with 'git worktree remove --force <path>'). Also unregisters any project whose repoPath is both gone from disk and under the OS temp dir (leaked test/lab fixtures), and reports any OTHER registered project with a missing repoPath so it stays visible instead of silent -- non-temp paths are never auto-removed.")
    .addHelpText("after", `
Example:
  $ agentic-kanban cleanup
  # Then manually remove stale worktrees with:
  $ git worktree remove --force <path>
`)
    .action(async () => {
      try {
        await runMigrations();

        const closedWorkspaces = await getClosedWorkspaces();
        const withWorktrees = closedWorkspaces.filter((ws) => ws.workingDir);

        if (withWorktrees.length === 0) {
          console.log("No stale worktrees found.");
        } else {
          console.log(`Found ${withWorktrees.length} closed workspace(s) with worktrees:`);
          for (const ws of withWorktrees) {
            console.log(`  ${ws.branch} -> ${ws.workingDir}`);
          }
          console.log("\nThese worktrees can be removed manually with:");
          console.log("  git worktree remove --force <path>");
        }

        const removed = await unregisterLeakedTempProjects();
        if (removed.length > 0) {
          console.log(`\nUnregistered ${removed.length} leaked temp-fixture project(s):`);
          for (const p of removed) {
            console.log(`  "${p.name}" -> ${p.repoPath}`);
          }
        } else {
          console.log("\nNo leaked temp-fixture projects found.");
        }

        const stillMissing = await findProjectsWithMissingRepoPath();
        if (stillMissing.length > 0) {
          console.log(`\n${stillMissing.length} registered project(s) have a missing repoPath (NOT auto-removed -- outside the temp dir, verify before unregistering manually):`);
          for (const p of stillMissing) {
            console.log(`  "${p.name}" -> ${p.repoPath}`);
          }
        }

        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
