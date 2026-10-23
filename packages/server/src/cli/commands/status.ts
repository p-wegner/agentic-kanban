import type { Command } from "commander";
import { timeSince, cliAction } from "../shared.js";
import { formatDurationStr } from "@agentic-kanban/shared";
import { plainHttp } from "../../lib/board-server-writes.js";
import type { getBoardStatus } from "../../services/board-status.js";

// #1492: a held pre-merge gate reads "gate held: <reason>, retry at <time>", not "auto-merge pending".
function pendingMergeLabel(mergeState: { reason?: string; label: string }): string {
  return mergeState.reason === "gate-held" ? mergeState.label : "auto-merge pending";
}

type StatusOptions = { project?: string; all?: boolean; json?: boolean; watch?: boolean; interval?: string };
type BoardStatusResult = Awaited<ReturnType<typeof getBoardStatus>>;
type StatusIssue = BoardStatusResult["issues"][number];
/** Mutable watch-loop state shared by the render paths and the key handler. */
type PollState = { allIssues: boolean; lastPollMs: number };

/** The console's own HTTP timeout; a poll counts as at most this long for the backoff (#1676). */
export const POLL_TIMEOUT_MS = 15_000;
const BACKOFF_CAP_SEC = 300;
const BACKOFF_CAP_FACTOR = 5;

// #1614: polls never overlap; a slow answer (> half the interval) doubles the wait to 2x its duration.
// #1676: capped at 5x the base interval (and 5 min), so one hung poll cannot stall the console for hours.
export function intervalSecFor(baseSec: number, lastPollMs: number): number {
  const cap = Math.max(baseSec, Math.min(baseSec * BACKOFF_CAP_FACTOR, BACKOFF_CAP_SEC));
  const wanted = Math.max(baseSec, Math.ceil((lastPollMs * 2) / 1000));
  return Math.min(wanted, cap);
}

/** A poll that ran past its timeout counts as a timeout, not its real duration. */
export function pollDurationForBackoff(elapsedMs: number): number {
  return Math.min(elapsedMs, POLL_TIMEOUT_MS);
}

function issueNum(issue: StatusIssue): string {
  return issue.issueNumber != null ? `#${issue.issueNumber}` : "???";
}

function printLastMessage(issue: StatusIssue): void {
  if (issue.lastAgentMessage) {
    const msg = issue.lastAgentMessage.length > 200 ? issue.lastAgentMessage.slice(0, 197) + "..." : issue.lastAgentMessage;
    console.log(`         last: ${msg.split("\n")[0]}`);
  } else if (issue.lastOutput.length > 0) {
    console.log(`         last: ${issue.lastOutput[0]}`);
  }
}

function printPendingMerge(issues: StatusIssue[]): void {
  if (issues.length === 0) return;
  console.log("  Pending merge");
  for (const issue of issues) {
    const diff = issue.diffStats ? `+${issue.diffStats.insertions}/-${issue.diffStats.deletions}` : "diff pending";
    console.log(`    auto-merge ${issueNum(issue).padEnd(4)} ${issue.title}`);
    console.log(`         [${issue.statusName}]  workspace: ${issue.workspace?.status ?? "no workspace"}  ${diff}`);
  }
  console.log("");
}

function printNeedsAttention(issues: StatusIssue[]): void {
  if (issues.length === 0) return;
  console.log("  Needs attention");
  for (const issue of issues) {
    console.log(`    ${issue.attention?.reason ?? "needs-attention"} ${issueNum(issue).padEnd(4)} ${issue.title}`);
    console.log(`         [${issue.statusName}]  workspace: ${issue.workspace?.status ?? "no workspace"}`);
    if (issue.attention?.label) {
      console.log(`         reason: ${issue.attention.label}`);
    }
    printLastMessage(issue);
  }
  console.log("");
}

const WORKSPACE_MARKERS: Record<string, string> = { active: "*", fixing: "*", idle: "o", reviewing: "o" };

function printWorkspaceInfo(issue: StatusIssue): void {
  if (!issue.workspace) return;
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

function printSessionInfo(issue: StatusIssue): void {
  if (!issue.session) return;
  const sessionParts: string[] = [issue.session.status];
  if (issue.lastActivity) sessionParts.push(`${timeSince(new Date(issue.lastActivity))} ago`);
  if (issue.sessionStats?.durationMs) sessionParts.push(formatDurationStr(issue.sessionStats.durationMs));
  console.log(`         session: ${sessionParts.join(" · ")}`);
}

function printIssueRow(issue: StatusIssue): void {
  const wsStatus = issue.workspace?.status ?? "no workspace";
  const marker = WORKSPACE_MARKERS[wsStatus] ?? ".";
  console.log(`  ${marker} ${issueNum(issue).padEnd(4)} ${issue.title}`);
  console.log(`         [${issue.statusName}]  workspace: ${wsStatus}`);
  printWorkspaceInfo(issue);
  printSessionInfo(issue);
  printLastMessage(issue);
  if (issue.lastActivity) {
    console.log(`         last activity: ${timeSince(new Date(issue.lastActivity))} ago`);
  }
  console.log("");
}

function printPlainStatus(status: BoardStatusResult): void {
  console.log(`\n  Board Status: ${status.project.name}`);
  console.log(`  ${status.totals.totalIssues} issues (${status.totals.inProgress} in-progress) | ${status.totals.activeWorkspaces} active workspaces | ${status.totals.runningSessions} running sessions`);
  console.log(`  Generated: ${new Date(status.generatedAt).toLocaleTimeString()}\n`);

  if (status.issues.length === 0) {
    console.log("  No active issues found. Use --all to include completed items.");
    return;
  }
  printPendingMerge(status.issues.filter((issue) => issue.mergeState?.reason === "auto-merge-in-review"));
  printNeedsAttention(status.issues.filter((issue) => issue.attention?.bucket === "needs_attention"));
  for (const issue of status.issues) printIssueRow(issue);
}

async function boardGet(baseUrl: string, path: string): Promise<unknown> {
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
}

// #1421: the operator console reads the board that owns the fleet over HTTP, so remote
// workers, trains and host capacity are visible. Falls back to the DB-backed frame only
// when no board answers.
// Resolves to null when the console was drawn, else the reason it could not be (#1477).
async function renderConsoleScreen(
  projectId: string | undefined,
  poll: PollState,
  baseIntervalSec: () => number,
): Promise<{ failure: unknown } | null> {
  const { resolveBoardServerPort } = await import("@agentic-kanban/shared/lib/board-server-url");
  const { buildConsoleModel, renderConsole, consoleFrame, fetchConsolePayloads } = await import("../status-console.js");
  const baseUrl = `http://127.0.0.1:${resolveBoardServerPort()}`;
  let payloads;
  const startedMs = Date.now();
  try {
    payloads = await fetchConsolePayloads((path) => boardGet(baseUrl, path), { projectId, all: poll.allIssues, nowMs: startedMs });
  } catch (failure) {
    poll.lastPollMs = pollDurationForBackoff(Date.now() - startedMs);
    return { failure };
  }
  const answerMs = Date.now() - startedMs;
  poll.lastPollMs = pollDurationForBackoff(answerMs);
  const model = buildConsoleModel(payloads);
  const intervalSec = intervalSecFor(baseIntervalSec(), poll.lastPollMs);
  const lines = renderConsole(model, {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
    color: !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
    ascii: !process.stdout.isTTY,
    intervalSec,
    nowMs: Date.now(),
    allIssues: poll.allIssues,
    backoffNote: intervalSec > baseIntervalSec() ? `backing off (slow answer ${Math.round(answerMs / 1000)} s), next refresh in ${intervalSec} s` : undefined,
  });
  process.stdout.write(process.stdout.isTTY ? consoleFrame(lines) : lines.join("\n") + "\n");
  return null;
}

async function renderFallbackScreen(status: BoardStatusResult, failure: unknown, all: boolean, intervalSec: number): Promise<void> {
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
    notice: consoleUnavailableNotice(failure),
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
    all,
    intervalSec,
  });
  // Clear + home, then write the frame in one go (no scrollback growth).
  process.stdout.write(frameToScreen(lines));
}

function enterAlternateScreen(onKey: (k: string) => void): void {
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const restore = () => process.stdout.write("\x1b[?25h\x1b[?1049l");
  process.on("exit", restore);
  process.on("SIGINT", () => process.exit(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => onKey(key.toString()));
  }
}

async function runWatchLoop(opts: {
  json: boolean;
  render: () => Promise<void>;
  poll: PollState;
  intervalSecOf: () => number;
}): Promise<never> {
  const { json, render, poll, intervalSecOf } = opts;
  const screen = !json && process.stdout.isTTY;
  if (screen) {
    enterAlternateScreen((k) => {
      if (k === "q" || k === "\u0003") process.exit(0);
      if (k === "a") { poll.allIssues = !poll.allIssues; void render(); }
    });
  }
  const renderAndClear = async () => {
    if (!screen && !json) console.clear();
    await render();
  };
  // Sequential loop, not setInterval: the next poll starts only after the previous one ended.
  for (;;) {
    await guardedRefresh(renderAndClear, (text) => process.stdout.write(text));
    await new Promise<void>((resolve) => setTimeout(resolve, intervalSecOf() * 1000));
  }
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
    .action(cliAction(async (options: StatusOptions) => {
      const { getBoardStatus } = await import("../../services/board-status.js");
      const fetchStatus = () => getBoardStatus({
        projectId: options.project,
        includeClosed: options.all,
        tailLines: 5,
      });
      const poll: PollState = { allIssues: Boolean(options.all), lastPollMs: 0 };
      const baseIntervalSec = () => Math.max(parseInt(options.interval ?? "5", 10), 2);
      const intervalSecOf = () => intervalSecFor(baseIntervalSec(), poll.lastPollMs);

      const renderPlain = async () => {
        const status = await fetchStatus();
        if (options.json) console.log(JSON.stringify(status, null, 2));
        else printPlainStatus(status);
      };
      const renderScreen = async () => {
        const consoleFailure = await renderConsoleScreen(options.project, poll, baseIntervalSec);
        if (!consoleFailure) return;
        await renderFallbackScreen(await fetchStatus(), consoleFailure.failure, poll.allIssues, intervalSecOf());
      };
      const render = options.watch && !options.json ? renderScreen : renderPlain;

      if (options.watch) {
        await runWatchLoop({ json: Boolean(options.json), render, poll, intervalSecOf });
      } else {
        await render();
        process.exit(0);
      }
    }));
}

/** One failed refresh must never end `--watch`: show the error in the frame; the next tick retries. */
export async function guardedRefresh(refresh: () => Promise<void>, write: (text: string) => void): Promise<boolean> {
  try {
    await refresh();
    return true;
  } catch (e) {
    write(`ATTENTION: refresh failed, retrying next tick: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}
