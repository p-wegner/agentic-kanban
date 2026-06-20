import type { Command } from "commander";
import { getProjectById, getProjectStatuses } from "../../repositories/project.repository.js";
import { getIssueStatusNameRowsForProject } from "../../repositories/issue.repository.js";
import { getActiveWorkspaceCount } from "../../repositories/workspace.repository.js";
import { runMigrations, getActiveProjectId } from "../shared.js";

const port = () => process.env.KANBAN_SERVER_PORT ?? "3001";
const apiBase = () => `http://127.0.0.1:${port()}/api`;

export function registerBoardCommand(program: Command) {
  const boardCmd = program.command("board").description("Board-level diagnostics and context.\n\nSubcommands: risk-digest, context");

  // ── risk-digest ───────────────────────────────────────────────────────────
  boardCmd
    .command("risk-digest")
    .description("Get a risk digest of the current board state: merge blockers, stale sessions, low backlog, and health issues.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- board risk-digest
  $ pnpm cli -- board risk-digest --json
  $ pnpm cli -- board risk-digest --project <project-id>`,
    )
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const res = await fetch(`${apiBase()}/projects/${encodeURIComponent(projectId)}/board-risk-digest`);
        if (!res.ok) {
          const text = await res.text();
          console.error(`Error ${res.status}: ${text}`);
          process.exit(1);
        }
        const digest = (await res.json()) as Record<string, unknown>;
        if (options.json) {
          console.log(JSON.stringify(digest, null, 2));
        } else {
          // Print a human-readable summary of the digest
          console.log("Board Risk Digest");
          console.log("=================");
          for (const [key, value] of Object.entries(digest)) {
            if (Array.isArray(value)) {
              console.log(`\n${key} (${value.length}):`);
              for (const item of value) {
                if (typeof item === "object" && item !== null) {
                  const obj = item as Record<string, unknown>;
                  const label = obj.issueId ?? obj.id ?? obj.workspaceId ?? JSON.stringify(obj);
                  const reason = obj.reason ?? obj.status ?? "";
                  console.log(`  - ${label}${reason ? `: ${reason}` : ""}`);
                } else {
                  console.log(`  - ${item}`);
                }
              }
            } else if (typeof value === "object" && value !== null) {
              console.log(`\n${key}:`);
              for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                console.log(`  ${k}: ${v}`);
              }
            } else {
              console.log(`${key}: ${value}`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── context ───────────────────────────────────────────────────────────────
  boardCmd
    .command("context")
    .description("Get current project context: project info, issue counts by status, and active workspaces.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- board context
  $ pnpm cli -- board context --json
  $ pnpm cli -- board context --project <project-id>`,
    )
    .action(async (options: { project?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());

        const project = await getProjectById(projectId);
        if (!project) {
          console.error(`Project '${projectId}' not found.`);
          process.exit(1);
        }

        const statuses = await getProjectStatuses(projectId);

        const issueRows = await getIssueStatusNameRowsForProject(projectId);

        const activeWorkspaceCount = await getActiveWorkspaceCount();

        const issueCounts: Record<string, number> = {};
        for (const issue of issueRows) {
          issueCounts[issue.statusName] = (issueCounts[issue.statusName] || 0) + 1;
        }

        const context = {
          project,
          statuses: statuses.map((s) => s.name),
          issueCounts,
          totalIssues: issueRows.length,
          activeWorkspaces: activeWorkspaceCount,
        };

        if (options.json) {
          console.log(JSON.stringify(context, null, 2));
        } else {
          console.log(`Project: ${context.project.name}`);
          if (context.project.repoPath) console.log(`  Path:   ${context.project.repoPath}`);
          console.log(`\nIssues (${context.totalIssues} total):`);
          for (const [status, count] of Object.entries(context.issueCounts)) {
            console.log(`  ${status}: ${count}`);
          }
          console.log(`\nActive workspaces: ${context.activeWorkspaces}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
