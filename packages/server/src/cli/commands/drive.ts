import type { Command } from "commander";
import { runMigrations, getActiveProjectId } from "../shared.js";
import { getDriveById } from "../../repositories/drive.repository.js";
import {
  computeReviewEffectiveness,
  renderReviewEffectivenessReport,
  resolveDriveIssueIds,
} from "../../services/review-effectiveness.service.js";

const port = () => process.env.KANBAN_SERVER_PORT ?? "3001";
const apiBase = () => `http://127.0.0.1:${port()}/api`;

export function registerDriveCommand(program: Command) {
  const driveCmd = program.command("drive").description("Inspect and manage autonomous-drive records.\n\nSubcommands: start, list, get, finish, review-effectiveness");

  // ── start ────────────────────────────────────────────────────────────────
  driveCmd
    .command("start")
    .description("Start a new Drive: a first-class record of an autonomous epic push toward a target.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--target <target>", "What the drive is steering toward (the goal / what 'done' looks like)")
    .option("--meta-issue <metaIssueId>", "Meta/epic issue ID this drive is pushing to completion")
    .option("--contract <completionContract>", "Explicit, checkable condition for finishing the drive")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- drive start --target "Ship epic #42 fully merged"
  $ pnpm cli -- drive start --target "All 12 tickets Done" --meta-issue abc-123 --contract "N/N issues merged"
  $ pnpm cli -- drive start --project proj-id --target "Finish auth module" --json`,
    )
    .action(async (options: { project?: string; target?: string; metaIssue?: string; contract?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        if (!options.target) {
          console.error("Error: --target is required");
          process.exit(1);
        }
        const body: Record<string, string> = { target: options.target };
        if (options.metaIssue) body.metaIssueId = options.metaIssue;
        if (options.contract) body.completionContract = options.contract;

        const res = await fetch(`${apiBase()}/projects/${encodeURIComponent(projectId)}/drives`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text();
          console.error(`Error ${res.status}: ${text}`);
          process.exit(1);
        }
        const drive = (await res.json()) as Record<string, unknown>;
        if (options.json) {
          console.log(JSON.stringify(drive, null, 2));
        } else {
          console.log(`Drive started: ${drive.id}`);
          console.log(`  Target:  ${drive.target}`);
          if (drive.metaIssueId) console.log(`  Meta-issue: ${drive.metaIssueId}`);
          if (drive.completionContract) console.log(`  Contract: ${drive.completionContract}`);
          console.log(`  Status:  ${drive.status}`);
          console.log(`  Started: ${drive.startedAt}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── list ─────────────────────────────────────────────────────────────────
  driveCmd
    .command("list")
    .description("List all Drives for a project (most recently started first).")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--status <status>", "Filter by drive status: active | completed | abandoned")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- drive list
  $ pnpm cli -- drive list --status active
  $ pnpm cli -- drive list --json`,
    )
    .action(async (options: { project?: string; status?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const res = await fetch(`${apiBase()}/projects/${encodeURIComponent(projectId)}/drives`);
        if (!res.ok) {
          const text = await res.text();
          console.error(`Error ${res.status}: ${text}`);
          process.exit(1);
        }
        let drives = (await res.json()) as Array<Record<string, unknown>>;
        if (options.status) {
          drives = drives.filter((d) => d.status === options.status);
        }
        if (options.json) {
          console.log(JSON.stringify(drives, null, 2));
        } else {
          if (drives.length === 0) {
            console.log("No drives found.");
          } else {
            for (const d of drives) {
              const window = d.finishedAt
                ? `${String(d.startedAt).slice(0, 10)}..${String(d.finishedAt).slice(0, 10)}`
                : `${String(d.startedAt).slice(0, 10)}..now`;
              console.log(`${d.id}  [${d.status}]  ${window}  ${d.target}`);
            }
          }
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── get ──────────────────────────────────────────────────────────────────
  driveCmd
    .command("get <drive-id>")
    .description("Get a single Drive by ID, including its target, completion contract, status, and timestamps.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- drive get <drive-id>
  $ pnpm cli -- drive get <drive-id> --json`,
    )
    .action(async (driveId: string, options: { project?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const res = await fetch(
          `${apiBase()}/projects/${encodeURIComponent(projectId)}/drives/${encodeURIComponent(driveId)}`,
        );
        if (!res.ok) {
          const text = await res.text();
          console.error(`Error ${res.status}: ${text}`);
          process.exit(1);
        }
        const drive = (await res.json()) as Record<string, unknown>;
        if (options.json) {
          console.log(JSON.stringify(drive, null, 2));
        } else {
          console.log(`ID:       ${drive.id}`);
          console.log(`Status:   ${drive.status}`);
          console.log(`Target:   ${drive.target}`);
          if (drive.metaIssueId) console.log(`Meta-issue: ${drive.metaIssueId}`);
          if (drive.completionContract) console.log(`Contract: ${drive.completionContract}`);
          console.log(`Started:  ${drive.startedAt}`);
          if (drive.finishedAt) console.log(`Finished: ${drive.finishedAt}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── finish ───────────────────────────────────────────────────────────────
  driveCmd
    .command("finish <drive-id>")
    .description("Finish a Drive: set terminal status (completed or abandoned) and stamp finishedAt.")
    .option("--project <projectId>", "Project ID (default: active project)")
    .option("--status <status>", "Terminal status: completed (default) | abandoned")
    .option("--json", "Emit machine-readable JSON")
    .addHelpText(
      "after",
      `
Examples:
  $ pnpm cli -- drive finish <drive-id>
  $ pnpm cli -- drive finish <drive-id> --status abandoned
  $ pnpm cli -- drive finish <drive-id> --json`,
    )
    .action(async (driveId: string, options: { project?: string; status?: string; json?: boolean }) => {
      try {
        await runMigrations();
        const projectId = options.project ?? (await getActiveProjectId());
        const body: Record<string, string> = {};
        if (options.status) body.status = options.status;

        const res = await fetch(
          `${apiBase()}/projects/${encodeURIComponent(projectId)}/drives/${encodeURIComponent(driveId)}/finish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          console.error(`Error ${res.status}: ${text}`);
          process.exit(1);
        }
        const drive = (await res.json()) as Record<string, unknown>;
        if (options.json) {
          console.log(JSON.stringify(drive, null, 2));
        } else {
          console.log(`Drive ${drive.id} finished.`);
          console.log(`  Status:   ${drive.status}`);
          console.log(`  Finished: ${drive.finishedAt}`);
          if (drive.retroPath) console.log(`  Retro:    ${drive.retroPath}`);
        }
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // ── review-effectiveness ─────────────────────────────────────────────────
  driveCmd
    .command("review-effectiveness <drive-id>")
    .description(
      "Per-drive AI code-review effectiveness: reviews run, reviews that bounced a ticket back, and merged-without-review.\n" +
        "Scoped to the drive's time window (startedAt..finishedAt) and — when the drive has a meta-issue — to that\n" +
        "meta-issue's dependency subtree. The drive analogue of `session review-effectiveness`.",
    )
    .option("--json", "Emit machine-readable JSON instead of a formatted report")
    .option(
      "--deep",
      "Also load each review session's transcript and classify its self-reported verdict (approve vs changes-requested). Slower.",
    )
    .option(
      "--whole-project",
      "Ignore the meta-issue subtree restriction and scope to the whole project within the drive's window.",
    )
    .action(async (driveId: string, options: { json?: boolean; deep?: boolean; wholeProject?: boolean }) => {
      try {
        await runMigrations();

        const drive = await getDriveById(driveId);
        if (!drive) {
          console.error(`Drive '${driveId}' not found.`);
          process.exit(1);
        }

        const sinceIso = drive.startedAt;
        // Open drives report up to "now"; finished drives are bounded by finishedAt.
        const untilIso = drive.finishedAt ?? null;

        const issueIds = options.wholeProject
          ? null
          : await resolveDriveIssueIds(drive.metaIssueId, drive.projectId);

        const report = await computeReviewEffectiveness({
          projectId: drive.projectId,
          sinceIso,
          untilIso,
          issueIds,
          deep: options.deep,
        });

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                drive: {
                  id: drive.id,
                  target: drive.target,
                  status: drive.status,
                  metaIssueId: drive.metaIssueId,
                  startedAt: drive.startedAt,
                  finishedAt: drive.finishedAt,
                  scope: options.wholeProject ? "whole-project" : drive.metaIssueId ? "meta-issue-subtree" : "whole-project-in-window",
                },
                ...report,
              },
              null,
              2,
            ),
          );
          process.exit(0);
        }

        const scopeNote = options.wholeProject
          ? "whole project in window"
          : issueIds
            ? `${issueIds.length} drive issues`
            : "whole project in window (no meta-issue)";
        const windowNote = untilIso ? `${sinceIso.slice(0, 10)}..${untilIso.slice(0, 10)}` : `${sinceIso.slice(0, 10)}..now`;
        console.log(
          renderReviewEffectivenessReport(
            report,
            `=== Drive Review Effectiveness — ${drive.target.slice(0, 50)} [${drive.status}] (${windowNote}, ${scopeNote}) ===`,
          ),
        );
        process.exit(0);
      } catch (err) {
        console.error("Error:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
