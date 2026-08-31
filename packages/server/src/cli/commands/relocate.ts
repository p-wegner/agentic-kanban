import type { Command } from "commander";
import { resolve } from "node:path";
import { getProjectByName, getProjectById } from "../../repositories/project.repository.js";
import { cliAction } from "../shared.js";
import {
  relocateProject,
  relocateProjectsUnderPrefix,
  type RelocationResult,
} from "../../services/project-relocate.service.js";

/**
 * `agentic-kanban relocate` (#964) — the operator-facing half of project relocation.
 *
 * The CLI is where a checkout move actually happens (you are already in a shell, moving
 * directories), so this is the surface that has to be pleasant: `--dry-run` first, then
 * the same command with `--move`. Everything it does goes through the same service the
 * REST routes call, so the two cannot drift.
 */
function printResult(result: RelocationResult, verbose: boolean): void {
  const verdict = result.applied ? "relocated" : result.dryRun ? "dry-run" : "BLOCKED";
  console.log(`\n[${verdict}] ${result.projectName}`);
  console.log(`  ${result.fromPath}`);
  console.log(`  -> ${result.toPath}`);

  for (const blocker of result.blockers) console.log(`  ! ${blocker}`);

  const byTable = new Map<string, number>();
  for (const change of result.changes) byTable.set(change.table, (byTable.get(change.table) ?? 0) + 1);
  const summary = [...byTable].map(([table, n]) => `${table}=${n}`).join(", ");
  console.log(`  ${result.changes.length} path reference(s) [${summary || "none"}]`);
  if (verbose) {
    for (const change of result.changes) {
      console.log(`    ${change.table}.${change.column} ${change.id}`);
      console.log(`      ${change.from}`);
      console.log(`      -> ${change.to}`);
    }
  }

  for (const move of result.directoryMoves) {
    console.log(`  mv (${move.kind}) ${move.from} -> ${move.to}`);
  }
  for (const repair of result.worktreeRepairs) {
    console.log(`  git worktree repair in ${repair.path}: ${repair.ok ? "ok" : `FAILED — ${repair.detail}`}`);
  }
}

export function registerRelocateCommand(program: Command) {
  program
    .command("relocate")
    .description(
      "Move a registered project to a new checkout path, keeping its issues, workspaces and history.\n\n" +
        "Rewrites every persisted path that pointed at the old location (projects.repo_path, repos.path,\n" +
        "repos.worktree_path, workspaces.working_dir, and the projects_base_path preference). Issue text,\n" +
        "comments and session records are left alone — they record what was true then.\n\n" +
        "With --prefix, both arguments are directories and EVERY project underneath the first is relocated.",
    )
    .argument("<project-or-from-prefix>", "Project name or ID — or, with --prefix, the directory to move out of")
    .argument("<new-path-or-to-prefix>", "The project's new absolute path — or, with --prefix, the directory to move into")
    .option("--prefix", "Relocate every project under the first directory into the second")
    .option("--move", "Also rename the directories on disk (and repair the worktrees)")
    .option("--dry-run", "Report exactly what would change and touch nothing")
    .option("--force", "Relocate even while one of the project's agents is running")
    .option("--keep-base-path", "Leave the projects_base_path preference pointing at the old directory")
    .option("-v, --verbose", "List every path reference, not just the per-table counts")
    .addHelpText(
      "after",
      `
Examples:
  $ agentic-kanban relocate --prefix --dry-run C:/projects/old C:/projects/new
  $ agentic-kanban relocate --prefix --move C:/projects/old C:/projects/new
  $ agentic-kanban relocate myapp D:/checkouts/myapp --move
`,
    )
    .action(
      cliAction(
        async (
          first: string,
          second: string,
          opts: {
            prefix?: boolean;
            move?: boolean;
            dryRun?: boolean;
            force?: boolean;
            keepBasePath?: boolean;
            verbose?: boolean;
          },
        ) => {
          const options = {
            moveFiles: !!opts.move,
            dryRun: !!opts.dryRun,
            force: !!opts.force,
            updateBasePath: !opts.keepBasePath,
          };

          if (opts.prefix) {
            const fromPrefix = resolve(first);
            const toPrefix = resolve(second);
            const batch = await relocateProjectsUnderPrefix(fromPrefix, toPrefix, options);
            if (batch.results.length === 0) {
              console.log(`No registered project lives under ${fromPrefix}.`);
              process.exit(0);
            }
            for (const result of batch.results) printResult(result, !!opts.verbose);
            if (batch.basePathChange) {
              console.log(`
preferences.projects_base_path`);
              console.log(`  ${batch.basePathChange.from}`);
              console.log(`  -> ${batch.basePathChange.to}`);
            }
            const blocked = batch.results.filter((r) => r.blockers.length > 0);
            const applied = batch.results.filter((r) => r.applied);
            console.log(
              `\n${applied.length} relocated, ${blocked.length} blocked, ${batch.results.length} considered.`,
            );
            process.exit(blocked.length > 0 ? 1 : 0);
          }

          const project = (await getProjectByName(first)) ?? (await getProjectById(first));
          if (!project) {
            console.error(`Project "${first}" not found.`);
            process.exit(1);
          }
          // The second argument is always the project's NEW PATH, never a parent to drop
          // it into: "relocate X into D:/checkouts" and "relocate X to D:/checkouts" are
          // indistinguishable as a string, and guessing gets a repo buried one level deep.
          const result = await relocateProject(project.id, resolve(second), options);
          printResult(result, !!opts.verbose);
          process.exit(result.blockers.length > 0 ? 1 : 0);
        },
      ),
    );
}
