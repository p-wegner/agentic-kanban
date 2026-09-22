import type { BoardStatusResponse, BoardStatusIssue } from "@agentic-kanban/shared";
import { ACTIVE_WORKSPACE_STATUSES } from "@agentic-kanban/shared";

/**
 * Pure frame renderer for `pnpm cli -- tracker` (#1141) — a dense, fixed-height terminal
 * view sized for a narrow herdr pane. Kept separate from the CLI wiring (polling,
 * redraw-in-place, SIGINT) so a test can render frames from a fixture snapshot at several
 * widths without spawning a server or a terminal.
 */

export interface TrackerFrameOptions {
  /** Terminal width to wrap/truncate against. Falls back to 80 when unset or non-positive. */
  width?: number;
  /** Injected for deterministic tests; epoch ms, defaults to the real clock. */
  nowMs?: number;
  /**
   * Live-refresh connection state (#1142) — `ws` when the board WebSocket is driving
   * refreshes, `polling` when it fell back to the interval timer, `connecting` before
   * the first attempt resolves either way. Omitted entirely when the caller has no
   * live transport (e.g. `--once`/`--json`), in which case no indicator is rendered.
   */
  connectionStatus?: "connecting" | "ws" | "polling";
}

const CONNECTION_INDICATOR: Record<"connecting" | "ws" | "polling", string> = {
  ws: "● live",
  polling: "○ polling",
  connecting: "◌ connecting",
};

const STATUS_GLYPH: Record<string, string> = {
  active: "*",
  fixing: "*",
  reviewing: "o",
  "awaiting-plan-approval": "o",
  idle: ".",
  blocked: "!",
  error: "x",
  closed: "-",
};

function glyphFor(status: string | undefined): string {
  if (!status) return ".";
  return STATUS_GLYPH[status] ?? ".";
}

/**
 * Statuses shown as an in-flight line in the tracker (#1225). Wider than
 * `ACTIVE_WORKSPACE_STATUSES` on purpose: that shared set feeds the operator focus filter
 * and WIP accounting elsewhere, where "blocked"/"error" correctly do NOT count as active
 * capacity — but the tracker's job is to show the operator what is happening, and a
 * quota-blocked or errored workspace disappearing entirely (while the header still says
 * "In Progress:1") is the exact failure this line list exists to avoid.
 */
const TRACKER_LINE_STATUSES = new Set<string>([...ACTIVE_WORKSPACE_STATUSES, "blocked", "error"]);

/** First non-empty line of an agent message, used as a short blocked/error reason. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim() : "";
}

/** `3h 12m` / `45s` — compact, no seconds once past a minute, matches `timeSince` elsewhere. */
export function ageSince(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "-";
  const ms = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + "…";
}

function clampWidth(width: number | undefined): number {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return 80;
  // Below this a line-per-workspace layout can't say anything useful; render narrower
  // than requested rather than crashing on a negative slice.
  return Math.max(20, Math.floor(width));
}

function columnCountsLine(issues: readonly BoardStatusIssue[], width: number): string {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.statusName, (counts.get(issue.statusName) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, count]) => `${name}:${count}`);
  return truncate(parts.join(" "), width);
}

export interface TrackerFrame {
  lines: string[];
  /** Rendered text, `lines.join("\n")` — what the CLI writes to the terminal. */
  text: string;
}

/**
 * Render one frame: header (project, WIP, column counts), one line per in-flight
 * workspace (glyph + age), then a blocked/attention section. Every line is truncated to
 * `width`; nothing wraps, so the frame's line count is fixed for a given snapshot.
 */
export function renderTrackerFrame(
  snapshot: BoardStatusResponse,
  wip: { limit: number },
  options: TrackerFrameOptions = {},
): TrackerFrame {
  const width = clampWidth(options.width);
  const nowMs = options.nowMs ?? Date.now();
  const lines: string[] = [];

  const indicator = options.connectionStatus ? ` | ${CONNECTION_INDICATOR[options.connectionStatus]}` : "";
  const header = truncate(
    `${snapshot.project.name} | WIP ${snapshot.totals.activeWorkspaces}/${wip.limit} | ${columnCountsLine(snapshot.issues, width)}${indicator}`,
    width,
  );
  lines.push(header);

  const inFlight = snapshot.issues.filter((issue) => issue.workspace && TRACKER_LINE_STATUSES.has(issue.workspace.status));
  if (inFlight.length === 0) {
    lines.push(truncate("(no in-flight workspaces)", width));
  } else {
    for (const issue of inFlight) {
      const status = issue.workspace?.status;
      const glyph = glyphFor(status);
      const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "#?";
      const age = ageSince(issue.lastActivity, nowMs);
      const reason =
        (status === "blocked" || status === "error") && issue.lastAgentMessage
          ? ` - ${firstLine(issue.lastAgentMessage)}`
          : "";
      lines.push(truncate(`${glyph} ${num} ${issue.title} (${age})${reason}`, width));
    }
  }

  const attention = snapshot.issues.filter((issue) => issue.attention?.bucket === "needs_attention");
  if (attention.length > 0) {
    lines.push(truncate("-- attention --", width));
    for (const issue of attention) {
      const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "#?";
      const reason = issue.attention?.label ?? issue.attention?.reason ?? "needs attention";
      lines.push(truncate(`! ${num} ${reason}`, width));
    }
  }

  return { lines, text: lines.join("\n") };
}
