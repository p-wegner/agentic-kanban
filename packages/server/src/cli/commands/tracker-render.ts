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
  /** Injected for deterministic tests; defaults to the real clock. */
  now?: Date;
}

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

/** `3h 12m` / `45s` — compact, no seconds once past a minute, matches `timeSince` elsewhere. */
export function ageSince(iso: string | null | undefined, now: Date): string {
  if (!iso) return "-";
  const ms = now.getTime() - new Date(iso).getTime();
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
  const now = options.now ?? new Date();
  const lines: string[] = [];

  const header = truncate(
    `${snapshot.project.name} | WIP ${snapshot.totals.activeWorkspaces}/${wip.limit} | ${columnCountsLine(snapshot.issues, width)}`,
    width,
  );
  lines.push(header);

  const inFlight = snapshot.issues.filter((issue) => issue.workspace && ACTIVE_WORKSPACE_STATUSES.has(issue.workspace.status));
  if (inFlight.length === 0) {
    lines.push(truncate("(no in-flight workspaces)", width));
  } else {
    for (const issue of inFlight) {
      const glyph = glyphFor(issue.workspace?.status);
      const num = issue.issueNumber != null ? `#${issue.issueNumber}` : "#?";
      const age = ageSince(issue.lastActivity, now);
      lines.push(truncate(`${glyph} ${num} ${issue.title} (${age})`, width));
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
