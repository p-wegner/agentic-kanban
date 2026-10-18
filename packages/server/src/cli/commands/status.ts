import type { Command } from "commander";
import { timeSince, cliAction } from "../shared.js";
import { formatDurationStr } from "@agentic-kanban/shared";

// #1492: a held pre-merge gate reads "gate held: <reason>, retry at <time>", not "auto-merge pending".
function pendingMergeLabel(mergeState: { reason?: string; label: string }): string {
  return mergeState.reason === "gate-held" ? mergeState.label : "auto-merge pending";
}

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show board status overview with all active agents, workspaces, and progress.\n\nDisplays a summary of issues, their workspace/session state, diff stats, token usage, and last agent output. By default only shows active (non-completed) issues.")
    .option("-p, --project <id>", "Project ID (defaults to active project)")
    .option("-a, --all", "Include closed/done issues", false)
    .option("--json", "Output raw JSON instead of formatted text")
    .option("-w, --watch", "Auto-refresh display at regular intervals")
    .option("-i, --interval <seconds>", "Refresh interval in seconds (default: 5, minimum: 2)", "5")
    .addHelpText("after", `
Examples:
  $ agentic-kanban status                       # active issues only
  $ agentic-kanban status --all                 # include completed issues
  $ agentic-kanban status --json                # machine-readable output
  $ agentic-kanban status --watch               # auto-refresh every 5s
  $ agentic-kanban status -w -i 10              # auto-refresh every 10s

Status indicators:
  * = active/fixing workspace   o = idle workspace   o = reviewing   . = no workspace
`)
    .action(cliAction(async (options: { project?: string; all?: boolean; json?: boolean; watch?: boolean; interval?: string }) => {
      const { getBoardStatus } = await import("../../services/board-status.js");

      const fetchStatus = () => getBoardStatus({
        projectId: options.project,
        includeClosed: options.all,
        tailLines: 5,
      });

      const renderPlain = async () => {
        const status = await fetchStatus();

        if (options.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }

        console.log(`\n  Board Status: ${status.project.name}`);
        console.log(`  ${status.totals.totalIssues} issues (${status.totals.inProgress} in-progress) | ${status.totals.activeWorkspaces} active workspaces | ${status.totals.runningSessions} running sessions`);
        console.log(`  Generated: ${new Date(status.generatedAt).toLocaleTimeString()}\n`);

        if (status.issues.length === 0) {
          console.log("  No active issues found. Use --all to include completed items.");
          return;
        }

        const needsAttention = status.issues.filter((issue) => issue.attention?.bucket === "needs_attention");
        const pendingMerge = status.issues.filter((issue) => issue.mergeState?.reason === "auto-merge-in-review");
        if (pendingMerge.length > 0) {
          console.log("  Pending merge");
          for (const issue of pendingMerge) {
            const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "???";
            const diff = issue.diffStats ? `+${issue.diffStats.insertions}/-${issue.diffStats.deletions}` : "diff pending";
            console.log(`    auto-merge ${num.padEnd(4)} ${issue.title}`);
            console.log(`         [${issue.statusName}]  workspace: ${issue.workspace?.status ?? "no workspace"}  ${diff}`);
          }
          console.log("");
        }

        if (needsAttention.length > 0) {
          console.log("  Needs attention");
          for (const issue of needsAttention) {
            const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "???";
            const wsStatus = issue.workspace?.status ?? "no workspace";
            console.log(`    ${issue.attention?.reason ?? "needs-attention"} ${num.padEnd(4)} ${issue.title}`);
            console.log(`         [${issue.statusName}]  workspace: ${wsStatus}`);
            if (issue.attention?.label) {
              console.log(`         reason: ${issue.attention.label}`);
            }
            if (issue.lastAgentMessage) {
              const msg = issue.lastAgentMessage.length > 200 ? issue.lastAgentMessage.slice(0, 197) + "..." : issue.lastAgentMessage;
              console.log(`         last: ${msg.split("\n")[0]}`);
            } else if (issue.lastOutput.length > 0) {
              console.log(`         last: ${issue.lastOutput[0]}`);
            }
          }
          console.log("");
        }

        for (const issue of status.issues) {
          const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "???";
          const wsStatus = issue.workspace?.status ?? "no workspace";
          const marker = wsStatus === "active" || wsStatus === "fixing" ? "*" : wsStatus === "idle" ? "o" : wsStatus === "reviewing" ? "o" : ".";
          console.log(`  ${marker} ${num.padEnd(4)} ${issue.title}`);
          console.log(`         [${issue.statusName}]  workspace: ${wsStatus}`);

          if (issue.workspace) {
            const wsInfo: string[] = [issue.workspace.branch];
            if (issue.workspace.isDirect) wsInfo.push("direct");
            if (issue.diffStats && (issue.diffStats.filesChanged > 0 || issue.diffStats.insertions > 0 || issue.diffStats.deletions > 0)) {
              wsInfo.push(`+${issue.diffStats.insertions}/-${issue.diffStats.deletions}`);
            }
            if (issue.mergeState?.bucket === "pending_merge") {
              wsInfo.push(pendingMergeLabel(issue.mergeState));
            }
            console.log(`         ${wsInfo.join(" · ")}`);
          }

          if (issue.session) {
            const sessionParts: string[] = [issue.session.status];
            if (issue.lastActivity) sessionParts.push(`${timeSince(new Date(issue.lastActivity))} ago`);
            if (issue.sessionStats?.durationMs) sessionParts.push(formatDurationStr(issue.sessionStats.durationMs));
            console.log(`         session: ${sessionParts.join(" · ")}`);
          }

          if (issue.lastAgentMessage) {
            const msg = issue.lastAgentMessage.length > 200 ? issue.lastAgentMessage.slice(0, 197) + "..." : issue.lastAgentMessage;
            console.log(`         last: ${msg.split("\n")[0]}`);
          } else if (issue.lastOutput.length > 0) {
            console.log(`         last: ${issue.lastOutput[0]}`);
          }

          if (issue.lastActivity) {
            console.log(`         last activity: ${timeSince(new Date(issue.lastActivity))} ago`);
          }

          console.log("");
        }
      };

      let allIssues = Boolean(options.all);
      const baseIntervalSec = () => Math.max(parseInt(options.interval ?? "5", 10), 2);
      // #1614: polls never overlap; a slow answer (> half the interval) doubles the wait to 2x its duration.
      let lastPollMs = 0;
      const intervalSecOf = () => Math.max(baseIntervalSec(), Math.ceil((lastPollMs * 2) / 1000));
      const backoffNoteOf = () =>
        intervalSecOf() > baseIntervalSec() ? `slow answer ${(lastPollMs / 1000).toFixed(1)}s, backing off` : undefined;

      // #1421: the operator console reads the board that owns the fleet over HTTP, so remote
      // workers, trains and host capacity are visible. Falls back to the DB-backed frame only
      // when no board answers.
      // Resolves to null when the console was drawn, else the reason it could not be (#1477).
      const renderConsoleScreen = async (): Promise<{ failure: unknown } | null> => {
        const { resolveBoardServerPort } = await import("@agentic-kanban/shared/lib/board-server-url");
        const { plainHttp } = await import("../board-server-writes.js");
        const { buildConsoleModel, renderConsole, consoleFrame, fetchConsolePayloads } = await import("../status-console.js");
        const baseUrl = `http://127.0.0.1:${resolveBoardServerPort()}`;
        const get = async (path: string): Promise<unknown> => {
          // 15 s: /status takes several seconds on a busy board, and a timeout here silently drops the
          // whole console back to the DB-backed list (#1477).
          let answer;
          try {
            answer = await plainHttp(`${baseUrl}${path}`, { method: "GET", timeoutMs: 15_000 });
          } catch (e) {
            throw new Error(`GET ${path} ${e instanceof Error ? e.message : String(e)}`);
          }
          if (answer.status < 200 || answer.status >= 300) throw new Error(`HTTP ${answer.status} ${path}`);
          return JSON.parse(answer.text);
        };
        let payloads;
        const startedMs = Date.now();
        try {
          payloads = await fetchConsolePayloads(get, { projectId: options.project, all: allIssues, nowMs: startedMs });
        } catch (failure) {
          lastPollMs = Date.now() - startedMs;
          return { failure };
        }
        lastPollMs = Date.now() - startedMs;
        const model = buildConsoleModel(payloads);
        const lines = renderConsole(model, {
          cols: process.stdout.columns || 120,
          rows: process.stdout.rows || 40,
          color: !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
          ascii: !process.stdout.isTTY,
          intervalSec: intervalSecOf(),
          nowMs: Date.now(),
          allIssues,
          backoffNote: backoffNoteOf(),
        });
        process.stdout.write(process.stdout.isTTY ? consoleFrame(lines) : lines.join("\n") + "\n");
        return null;
      };

      const renderScreen = async () => {
        const consoleFailure = await renderConsoleScreen();
        if (!consoleFailure) return;
        const status = await fetchStatus();
        const { renderStatusScreen, frameToScreen, consoleUnavailableNotice } = await import("../status-screen.js");
        let onlineWorkers: number | undefined;
        try {
          const { getWorkerRegistry } = await import("../../services/worker-registry.service.js");
          onlineWorkers = (await getWorkerRegistry().listWorkersView()).filter((w) => w.effectiveStatus === "online").length;
        } catch {
          // registry unreadable: the renderer falls back to its own estimate
        }
        const lines = renderStatusScreen(status, {
          onlineWorkers,
          notice: consoleUnavailableNotice(consoleFailure.failure),
          cols: process.stdout.columns || 120,
          rows: process.stdout.rows || 40,
          all: allIssues,
          intervalSec: intervalSecOf(),
        });
        // Clear + home, then write the frame in one go (no scrollback growth).
        process.stdout.write(frameToScreen(lines));
      };

      const render = options.watch && !options.json ? renderScreen : renderPlain;

      if (options.watch) {
        const screen = !options.json && process.stdout.isTTY;
        if (screen) {
          process.stdout.write("\x1b[?1049h\x1b[?25l");
          const restore = () => process.stdout.write("\x1b[?25h\x1b[?1049l");
          process.on("exit", restore);
          process.on("SIGINT", () => process.exit(0));
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", (key: Buffer) => {
              const k = key.toString();
              if (k === "q" || k === "\u0003") process.exit(0);
              if (k === "a") { allIssues = !allIssues; void render(); }
            });
          }
        }
        const renderAndClear = async () => {
          if (!screen && !options.json) console.clear();
          await render();
        };
        // Sequential loop, not setInterval: the next poll starts only after the previous one ended.
        for (;;) {
          try {
            await renderAndClear();
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
          }
          await new Promise<void>((resolve) => setTimeout(resolve, intervalSecOf() * 1000));
        }
      } else {
        await render();
        process.exit(0);
      }
    }));
}
