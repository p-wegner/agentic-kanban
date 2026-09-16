import type { Command } from "commander";
import { cliAction, resolveProjectIdArg } from "../shared.js";
import { renderTrackerFrame } from "./tracker-render.js";

/**
 * `pnpm cli -- tracker` (#1141) — a dense, fixed-height terminal dashboard sized for a
 * narrow herdr pane. Polls `getBoardStatus` in-process (same pattern as `status --watch`,
 * see `commands/status.ts`) rather than over HTTP — the CLI and server share the DB, so
 * there is no server round-trip to make.
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

      const renderOnce = async () => {
        const snapshot = await getBoardStatus({ projectId });
        if (options.json) {
          console.log(JSON.stringify(snapshot, null, 2));
          return;
        }
        const prefMap = toPrefMap(await getAllPreferences());
        const wip = resolveWipLimit(prefMap, projectId);
        const frame = renderTrackerFrame(snapshot, wip, { width: process.stdout.columns });
        console.log(frame.text);
      };

      if (options.once || options.json) {
        await renderOnce();
        process.exit(0);
        return;
      }

      const intervalSec = Math.max(parseInt(options.interval ?? "5", 10), 2);
      let stopped = false;
      const shutdown = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      const renderAndClear = async () => {
        console.clear();
        await renderOnce();
        console.log(`\nRefreshing every ${intervalSec}s. Press Ctrl+C to exit.`);
      };
      await renderAndClear();
      const timer = setInterval(() => {
        if (!stopped) void renderAndClear();
      }, intervalSec * 1000);
    }));
}
