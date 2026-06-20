import type { Command } from "commander";
import { getProjectById } from "../../repositories/project.repository.js";
import { runMigrations, getActiveProjectId } from "../shared.js";
import {
  listOpenSpecs,
  showOpenSpec,
  validateOpenSpecChange,
} from "@agentic-kanban/shared/lib/openspec";

async function resolveRepoPath(projectId: string): Promise<string | null> {
  const project = await getProjectById(projectId);
  return project?.repoPath ?? null;
}

export function registerOpenspecCommand(program: Command) {
  const openspecCmd = program.command("openspec").description("Manage living OpenSpec domain specifications.\n\nSubcommands: list, show, validate");

  // ── list ─────────────────────────────────────────────────────────────────
  openspecCmd
    .command("list")
    .description("List the living OpenSpec domains for the active project.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- openspec list
  $ pnpm cli -- openspec list --json
  $ pnpm cli -- openspec list --project <project-id>`,
    )
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const repoPath = await resolveRepoPath(projectId);
        if (!repoPath) {
          console.error(`Project '${projectId}' not found.`);
          process.exit(1);
        }
        const specs = await listOpenSpecs(repoPath);
        if (options.json) {
          console.log(JSON.stringify({ specs }, null, 2));
        } else {
          if (specs.length === 0) {
            console.log("No OpenSpec domains found.");
          } else {
            for (const s of specs) {
              console.log(`${s.domain}  (${s.path})`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── show ─────────────────────────────────────────────────────────────────
  openspecCmd
    .command("show <domain>")
    .description("Show a living OpenSpec domain spec.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- openspec show butler-context
  $ pnpm cli -- openspec show workspace-merge --json
  $ pnpm cli -- openspec show butler-context --project <project-id>`,
    )
    .action(async (domain: string, options: { project?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const repoPath = await resolveRepoPath(projectId);
        if (!repoPath) {
          console.error(`Project '${projectId}' not found.`);
          process.exit(1);
        }
        const spec = await showOpenSpec(repoPath, domain);
        if (options.json) {
          console.log(JSON.stringify(spec, null, 2));
        } else {
          console.log(`# ${spec.domain}  (${spec.path})\n`);
          console.log(spec.content);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── validate ─────────────────────────────────────────────────────────────
  openspecCmd
    .command("validate [change]")
    .description("Validate OpenSpec change deltas under openspec/changes. Checks ADDED/MODIFIED/REMOVED sections and warns about same-domain delta collisions.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- openspec validate
  $ pnpm cli -- openspec validate my-change-id
  $ pnpm cli -- openspec validate --json`,
    )
    .action(async (change: string | undefined, options: { project?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const repoPath = await resolveRepoPath(projectId);
        if (!repoPath) {
          console.error(`Project '${projectId}' not found.`);
          process.exit(1);
        }
        const result = await validateOpenSpecChange(repoPath, change);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const status = result.valid ? "VALID" : "INVALID";
          console.log(`Validation: ${status}`);
          console.log(`  Deltas:   ${result.deltas.length}`);
          if (result.errors.length > 0) {
            console.log("\nErrors:");
            for (const e of result.errors) console.log(`  ✖ ${e}`);
          }
          if (result.warnings.length > 0) {
            console.log("\nWarnings:");
            for (const w of result.warnings) console.log(`  ⚠ ${w}`);
          }
          if (result.deltas.length > 0) {
            console.log("\nDeltas:");
            for (const d of result.deltas) {
              console.log(`  ${d.changeId}/${d.domain}  (${d.path})`);
            }
          }
        }
        process.exit(result.valid ? 0 : 1);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
