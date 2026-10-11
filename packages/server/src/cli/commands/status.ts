import type { Command } from "commander";
import { timeSince, cliAction } from "../shared.js";
import { formatDurationStr } from "@agentic-kanban/shared";

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
              wsInfo.push("auto-merge pending");
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

      const renderScreen = async () => {
        const status = await fetchStatus();
        const { renderStatusScreen, frameToScreen } = await import("../status-screen.js");
        const lines = renderStatusScreen(status, {
          cols: process.stdout.columns || 120,
          rows: process.stdout.rows || 40,
          all: options.all,
          intervalSec: Math.max(parseInt(options.interval ?? "5", 10), 2),
        });
        // Clear + home, then write the frame in one go (no scrollback growth).
        process.stdout.write(frameToScreen(lines));
      };

      const render = options.watch && !options.json ? renderScreen : renderPlain;

      if (options.watch) {
        const intervalSec = Math.max(parseInt(options.interval ?? "5", 10), 2);
        const screen = !options.json && process.stdout.isTTY;
        if (screen) {
          process.stdout.write("\x1b[?1049h\x1b[?25l");
          const restore = () => process.stdout.write("\x1b[?25h\x1b[?1049l");
          process.on("exit", restore);
          process.on("SIGINT", () => process.exit(0));
        }
        const renderAndClear = async () => {
          if (!screen && !options.json) console.clear();
          await render();
        };
        await renderAndClear();
        setInterval(() => {
          void renderAndClear();
        }, intervalSec * 1000);
      } else {
        await render();
        process.exit(0);
      }
    }));
}
