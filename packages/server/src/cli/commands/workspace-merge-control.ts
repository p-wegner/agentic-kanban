// Workspace CLI: per-workspace merge cancel/hold subcommands (#1164). Extracted from
// workspace.ts so `registerWorkspaceCommand` stays under the `function-nloc-ratchet` (#800)
// shrink-only ring — same split shape as workspace-interaction.ts (#859). Registered onto the
// same wsCmd so `pnpm cli -- workspace <sub>` is unchanged. CLI stays a thin transport (no
// inline db).
import type { Command } from "commander";
import { buildWorkspaceApiUrl } from "./workspace-api-url.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** Shape of the error envelope every workspace action endpoint returns on failure. */
interface ErrorResponse {
  error?: string;
}

/** POST .../merge/cancel — cancel result (#1164). */
interface MergeCancelResponse extends ErrorResponse {
  workspaceId?: string;
  cancelled?: boolean;
  wasQueued?: boolean;
  wasGating?: boolean;
  releasedLock?: boolean;
  jobCancelled?: boolean;
  reason?: string;
}

/** POST|GET|DELETE .../merge-hold — hold state (#1164). */
interface MergeHoldResponse extends ErrorResponse {
  workspaceId?: string;
  held?: boolean;
  reason?: string | null;
  heldAt?: string;
}

export function registerWorkspaceMergeControlCommands(wsCmd: Command) {
  wsCmd
    .command("merge-cancel <workspace-id>")
    .description("Cancel this workspace's merge job (#1164).\n\nRemoves a queued verify chain, aborts an in-flight gate run, releases the merge lock if held, and marks the tracked job cancelled. A targeted alternative to disabling auto-merge for the whole project. Idempotent — safe to call on a workspace with nothing running. Requires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_BOARD_SERVER_PORT/$KANBAN_SERVER_PORT/$SERVER_PORT/$PORT, or 3001)")
    .option("-r, --reason <reason>", "Why the merge is being cancelled")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace merge-cancel <workspace-id> -r "red gate, stuck"
`)
    .action(async (workspaceId: string, options: { port?: string; reason?: string }) => {
      try {
        const port = options.port ?? "";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "merge/cancel"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.reason ? { reason: options.reason } : {}),
        });
        const data = await res.json() as MergeCancelResponse;

        if (!res.ok) {
          console.error(`Merge cancel failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Cancel requested for workspace '${workspaceId}': cancelled=${data.cancelled}`);
        console.log(`  wasQueued=${data.wasQueued} wasGating=${data.wasGating} releasedLock=${data.releasedLock} jobCancelled=${data.jobCancelled}`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", errorMessage(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("merge-hold <workspace-id>")
    .description("Park a workspace so the monitor walk, the auto-merge orchestrator, and the merge-train reconciler all skip it, without disabling auto-merge for the rest of the project (#1164). Idempotent — re-holding updates the reason. Requires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_BOARD_SERVER_PORT/$KANBAN_SERVER_PORT/$SERVER_PORT/$PORT, or 3001)")
    .option("-r, --reason <reason>", "Why the workspace is being held")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace merge-hold <workspace-id> -r "red gate, investigating"
`)
    .action(async (workspaceId: string, options: { port?: string; reason?: string }) => {
      try {
        const port = options.port ?? "";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "merge-hold"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.reason ? { reason: options.reason } : {}),
        });
        const data = await res.json() as MergeHoldResponse;

        if (!res.ok) {
          console.error(`Merge hold failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Workspace '${workspaceId}' is now held (reason: ${data.reason ?? "none"})`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", errorMessage(err));
        process.exit(1);
      }
    });

  wsCmd
    .command("merge-hold-release <workspace-id>")
    .description("Release a workspace's merge hold (#1164), letting the monitor walk / auto-merge orchestrator / merge-train reconciler resume treating it normally. A no-op if it was not held. Requires the kanban server to be running (pnpm dev).")
    .option("-p, --port <port>", "Server port (default: $KANBAN_BOARD_SERVER_PORT/$KANBAN_SERVER_PORT/$SERVER_PORT/$PORT, or 3001)")
    .addHelpText("after", `
Example:
  $ agentic-kanban workspace merge-hold-release <workspace-id>
`)
    .action(async (workspaceId: string, options: { port?: string }) => {
      try {
        const port = options.port ?? "";
        const res = await fetch(buildWorkspaceApiUrl(port, workspaceId, "merge-hold"), {
          method: "DELETE",
        });
        const data = await res.json() as MergeHoldResponse;

        if (!res.ok) {
          console.error(`Merge hold release failed: ${data.error ?? res.statusText}`);
          process.exit(1);
        }

        console.log(`Workspace '${workspaceId}' hold released`);
        process.exit(0);
      } catch (err) {
        console.error("Error:", errorMessage(err));
        process.exit(1);
      }
    });
}
