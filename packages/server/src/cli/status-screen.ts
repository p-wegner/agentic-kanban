import type { BoardStatusIssue, BoardStatusResponse } from "@agentic-kanban/shared";

// Pure renderer for the compact `status --watch` screen. Returns exactly the lines to draw
// (never wider than `cols`, never more than `rows`) so the caller can repaint in place.

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export interface StatusScreenOptions {
  cols: number;
  rows: number;
  all?: boolean;
  color?: boolean;
  nowMs?: number;
  intervalSec?: number;
}

/** Truncate to `width` visible characters with an ellipsis; never wraps. */
export function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (width <= 0) return "";
  if (flat.length <= width) return flat;
  if (width === 1) return "…";
  return flat.slice(0, width - 1) + "…";
}

export function visibleLength(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

function age(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.floor((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function isActive(issue: BoardStatusIssue): boolean {
  const ws = issue.workspace?.status;
  return ws === "active" || ws === "fixing" || ws === "reviewing" || issue.session?.status === "running";
}

function isMerging(issue: BoardStatusIssue): boolean {
  return issue.mergeState?.bucket === "pending_merge";
}

function num(issue: BoardStatusIssue): string {
  return issue.issueNumber != null ? `#${issue.issueNumber}` : "#?";
}

/** Fit `left` plus a right-aligned `right` into `cols`, truncating only the left part. */
function fitRow(left: string, right: string, cols: number): string {
  const room = cols - right.length - (right ? 1 : 0);
  const l = truncate(left, Math.max(room, 8));
  const pad = Math.max(1, cols - l.length - right.length);
  return truncate(l + " ".repeat(pad) + right, cols);
}

function activeRow(issue: BoardStatusIssue, cols: number, nowMs: number): string {
  const diff = issue.diffStats && (issue.diffStats.insertions || issue.diffStats.deletions)
    ? `+${issue.diffStats.insertions}/-${issue.diffStats.deletions}`
    : "";
  const where = issue.remoteUnlanded?.workerId ? `@${issue.remoteUnlanded.workerId.slice(0, 8)}` : "local";
  const session = issue.session ? `${issue.session.status} ${where}` : "-";
  const right = [diff, session, age(issue.lastActivity ?? issue.session?.startedAt, nowMs)].filter(Boolean).join("  ");
  const head = `${num(issue).padEnd(5)} ${truncate(issue.statusName, 11).padEnd(11)} ${issue.title}`;
  return fitRow(head, right, cols);
}

export function renderStatusScreen(status: BoardStatusResponse, opts: StatusScreenOptions): string[] {
  const cols = Math.max(opts.cols, 20);
  const rows = Math.max(opts.rows, 3);
  const nowMs = opts.nowMs ?? Date.now();
  const dim = (s: string) => (opts.color === false ? s : `${DIM}${s}${RESET}`);

  const active = status.issues.filter((i) => isActive(i) && !isMerging(i));
  const merging = status.issues.filter(isMerging);
  const backlog = status.issues.filter((i) => !isActive(i) && !isMerging(i));
  const workers = new Set(
    status.issues.map((i) => i.remoteUnlanded?.workerId).filter((w): w is string => !!w),
  ).size;

  const out: string[] = [];
  const t = status.totals;
  out.push(truncate(
    `${status.project.name} | ${t.totalIssues} issues, ${t.inProgress} in progress, ${t.activeWorkspaces} ws, ${t.runningSessions} running | workers ${workers} | ${new Date(nowMs).toLocaleTimeString()}`,
    cols,
  ));

  const body: string[] = [];
  body.push(`ACTIVE (${active.length})`);
  for (const issue of active) {
    body.push(activeRow(issue, cols, nowMs));
    const msg = issue.lastAgentMessage?.split("\n")[0] ?? issue.lastOutput[0];
    if (msg) body.push(dim(truncate(`      ${msg}`, cols)));
  }
  if (active.length === 0) body.push(dim("  none"));

  if (merging.length > 0) {
    body.push(`MERGE (${merging.length})`);
    for (const issue of merging) {
      body.push(fitRow(`${num(issue).padEnd(5)} ${issue.title}`, truncate(issue.mergeState?.label ?? "pending merge", 24), cols));
    }
  }

  if (opts.all) {
    body.push(`BACKLOG (${backlog.length})`);
    for (const issue of backlog) {
      body.push(truncate(`${num(issue).padEnd(5)} ${truncate(issue.statusName, 11).padEnd(11)} ${issue.title}`, cols));
    }
  } else {
    body.push(dim(`BACKLOG ${backlog.length} (use --all to list)`));
  }

  const footer = dim(truncate(`every ${opts.intervalSec ?? 5}s · Ctrl+C to exit`, cols));
  const room = rows - out.length - 1;
  let shown = body;
  if (body.length > room) {
    shown = body.slice(0, Math.max(room - 1, 0));
    shown.push(dim(truncate(`… ${body.length - shown.length} more lines`, cols)));
  }
  return [...out, ...shown, footer];
}

/** Home + clear, then the frame, so each refresh repaints in place. */
export function frameToScreen(lines: string[]): string {
  return "\x1b[H\x1b[2J" + lines.join("\n");
}
