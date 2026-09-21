import type { Command } from "commander";
import { cliAction, resolveProjectIdArg } from "../shared.js";
import { renderTrackerFrame } from "./tracker-render.js";
import { createTrackerTransport, type TrackerConnectionStatus, type TrackerSocketLike } from "./tracker-transport.js";
import { resolveCliPort } from "./workspace-api-url.js";

/**
 * `pnpm cli -- tracker` (#1141) — a dense, fixed-height terminal dashboard sized for a
 * narrow herdr pane. Reads `getBoardStatus` in-process (same pattern as `status --watch`,
 * see `commands/status.ts`) — the CLI and server share the DB, so there is no server
 * round-trip to fetch the snapshot.
 *
 * The REFRESH TRIGGER (#1142), however, does round-trip: the live dashboard connects to
 * the board's own `/ws/board/:projectId` WebSocket (the same channel the browser client
 * subscribes to) and re-renders on relevant board events instead of a fixed timer, with
 * an interval-polling fallback while the socket is unavailable or reconnecting. See
 * `tracker-transport.ts` for the connect/fallback/backoff logic.
 */
export function registerTrackerCommand(program: Command) {
  program
    .command("tracker")
    .description("Compact live terminal dashboard: header (project, WIP, column counts), one line per in-flight workspace, and a blocked/attention section. Sized for a narrow pane; redraws in place.")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-i, --interval <seconds>", "Refresh interval in seconds (default: 5, minimum: 2)", "5")
    .option("--once", "Print a single frame and exit (no polling)")
    .option("--json", "Print the raw snapshot as JSON instead of a rendered frame (implies --once)")
    .addHelpText("after", `
Examples:
  $ agentic-kanban tracker                     # live dashboard, refresh every 5s
  $ agentic-kanban tracker --once              # one static frame
  $ agentic-kanban tracker --json              # raw snapshot JSON, scriptable
  $ agentic-kanban tracker -i 10 --project foo

Status glyphs:
  * = active/fixing   o = reviewing   ! = blocked   x = error   . = idle
`)
    .action(cliAction(async (options: { project?: string; interval?: string; once?: boolean; json?: boolean }) => {
      const { getBoardStatus } = await import("../../services/board-status.js");
      const { resolveWipLimit } = await import("../../services/wip-limit.service.js");
      const { getAllPreferences } = await import("../../repositories/preferences.repository.js");
      const { toPrefMap } = await import("@agentic-kanban/shared/lib/preference-map");

      const projectId = await resolveProjectIdArg(options.project);

      const renderOnce = async (connectionStatus?: TrackerConnectionStatus) => {
        const snapshot = await getBoardStatus({ projectId });
        if (options.json) {
          console.log(JSON.stringify(snapshot, null, 2));
          return;
        }
        const prefMap = toPrefMap(await getAllPreferences());
        const wip = resolveWipLimit(prefMap, projectId);
        const frame = renderTrackerFrame(snapshot, wip, { width: process.stdout.columns, connectionStatus });
        console.log(frame.text);
      };

      if (options.once || options.json) {
        await renderOnce();
        process.exit(0);
        return;
      }

      const parsedInterval = parseInt(options.interval ?? "5", 10);
      const intervalSec = Math.max(Number.isFinite(parsedInterval) ? parsedInterval : 5, 2);
      let stopped = false;
      let connectionStatus: TrackerConnectionStatus = "connecting";

      const renderAndClear = async () => {
        console.clear();
        try {
          await renderOnce(connectionStatus);
        } catch (err) {
          console.log(`(refresh failed: ${err instanceof Error ? err.message : String(err)})`);
        }
        console.log(`\nPress Ctrl+C to exit.`);
      };

      const port = resolveCliPort();
      const wsUrl = `ws://127.0.0.1:${port}/ws/board/${projectId}`;

      const transport = createTrackerTransport({
        connect: () => new WebSocket(wsUrl) as unknown as TrackerSocketLike,
        onRefresh: () => void renderAndClear(),
        onStatusChange: (status) => {
          connectionStatus = status;
        },
        pollIntervalMs: intervalSec * 1000,
      });

      const shutdown = () => {
        if (stopped) return;
        stopped = true;
        transport.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await renderAndClear();
      transport.start();
    }));
}
