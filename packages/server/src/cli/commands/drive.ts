import type { Command } from "commander";
import { db } from "../../db/index.js";
import { runMigrations } from "../shared.js";
import { getDriveById } from "../../repositories/drive.repository.js";
import {
  computeReviewEffectiveness,
  renderReviewEffectivenessReport,
  resolveDriveIssueIds,
} from "../../services/review-effectiveness.service.js";

export function registerDriveCommand(program: Command) {
  const driveCmd = program.command("drive").description("Inspect autonomous-drive records.\n\nSubcommands: review-effectiveness");

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

        const drive = await getDriveById(driveId, db);
        if (!drive) {
          console.error(`Drive '${driveId}' not found.`);
          process.exit(1);
        }

        const sinceIso = drive.startedAt;
        // Open drives report up to "now"; finished drives are bounded by finishedAt.
        const untilIso = drive.finishedAt ?? null;

        const issueIds = options.wholeProject
          ? null
          : await resolveDriveIssueIds(drive.metaIssueId, drive.projectId, db);

        const report = await computeReviewEffectiveness(
          { projectId: drive.projectId, sinceIso, untilIso, issueIds, deep: options.deep },
          db,
        );

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
