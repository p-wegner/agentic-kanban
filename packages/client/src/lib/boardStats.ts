import type { StatusWithIssues } from "@agentic-kanban/shared";

/**
 * Pure board-summary aggregates derived from the active/archive columns — the ONE place the
 * board header's numbers come from (#1162).
 *
 * The header used to show `13 open`, `1 active`, `anth 10`, a token meter's own agent count and
 * the Autopilot's `0/2 running`: five chips, four definitions, overlapping words. `anth 10`
 * counted every open ticket whose workspace had that profile, idle included, under a tooltip
 * claiming "10 active anth agents". The header now separates two concepts and gives each word
 * exactly one definition, written down in {@link PULSE_TERMS} so every tooltip quotes the same
 * sentence:
 *
 *  - **ticket flow** — how many tickets sit in each open column (`3 todo · 4 in progress`);
 *  - **agents running** — agent sessions working right now, by kind and profile.
 *
 * The Autopilot's slot arithmetic is a THIRD thing and keeps its own word, `WIP x/y`
 * (`autopilotChip.ts`), because it counts only In Progress tickets: a fix-and-merge agent on an
 * In Review ticket is an agent running but uses no WIP slot.
 */

/** The header's vocabulary. One definition per word; tooltips quote these verbatim. */
export const PULSE_TERMS = {
  tickets: "Tickets per open column. Done and cancelled are in the breakdown.",
  agentsRunning:
    "Agent sessions working right now: builders on In Progress tickets, reviewers, and fix-and-merge agents. Idle, blocked and errored workspaces are not counted.",
  wip:
    "WIP x/y: In Progress tickets with a running agent, against the Autopilot's Agents limit. Review and fix-and-merge agents on In Review tickets do not use a WIP slot.",
} as const;

/** What a running agent is doing, from its workspace status. */
export type AgentKind = "building" | "reviewing" | "fixing";

const KIND_BY_STATUS: Readonly<Record<string, AgentKind>> = {
  active: "building",
  reviewing: "reviewing",
  fixing: "fixing",
};

/** Headline order and wording for each kind. */
export const AGENT_KIND_LABEL: Readonly<Record<AgentKind, string>> = {
  building: "building",
  reviewing: "reviewing",
  fixing: "fix-and-merge",
};

export interface TicketFlowColumn {
  id: string;
  /** Column name as the board shows it. */
  name: string;
  /** Lower-case label for the headline (`in progress`). */
  label: string;
  count: number;
}

export interface AgentActivity {
  /** Agent sessions running right now — see {@link PULSE_TERMS.agentsRunning}. */
  running: number;
  byKind: Record<AgentKind, number>;
  /** Running agents per profile, most first. A profile with no running agent is absent. */
  byProfile: { profile: string; count: number }[];
  /** Running agents whose ticket is NOT in In Progress, so they use no WIP slot. */
  outsideInProgress: number;
}

export interface BoardStatsData {
  /** Active columns followed by archive columns, in order. */
  allColumns: StatusWithIssues[];
  /** Issue count across active (non-terminal) columns. */
  totalActive: number;
  /** Issue count across archive (Done/Cancelled) columns. */
  totalArchive: number;
  /** Grand total issue count. */
  total: number;
  doneCount: number;
  cancelledCount: number;
  /** Total excluding cancelled — the denominator for completion. */
  nonCancelledTotal: number;
  /** Done as a percentage of non-cancelled work (0 when there is none). */
  completionPct: number;
  /** Open columns with a ticket in them, in board order. */
  ticketFlow: TicketFlowColumn[];
  agents: AgentActivity;
}

/**
 * Agents running across the board. Counted per WORKSPACE, not per ticket: a ticket-group member
 * carries its lead's workspace summary, so counting tickets would show one agent twice.
 */
export function computeAgentActivity(columns: readonly StatusWithIssues[]): AgentActivity {
  const byKind: Record<AgentKind, number> = { building: 0, reviewing: 0, fixing: 0 };
  const profiles = new Map<string, number>();
  const seen = new Set<string>();
  let outsideInProgress = 0;

  for (const col of columns) {
    for (const issue of col.issues) {
      const main = issue.workspaceSummary?.main;
      const kind = main ? KIND_BY_STATUS[main.status] : undefined;
      if (!main || !kind) continue;
      const key = main.id || issue.id;
      if (seen.has(key)) continue;
      seen.add(key);
      byKind[kind]++;
      if (col.name !== "In Progress") outsideInProgress++;
      // Prefer the tagged profile, fall back to the legacy claudeProfile string.
      const profile = main.profile?.name ?? main.claudeProfile;
      if (profile) profiles.set(profile, (profiles.get(profile) ?? 0) + 1);
    }
  }

  return {
    running: byKind.building + byKind.reviewing + byKind.fixing,
    byKind,
    byProfile: [...profiles.entries()]
      .map(([profile, count]) => ({ profile, count }))
      .sort((a, b) => b.count - a.count || a.profile.localeCompare(b.profile)),
    outsideInProgress,
  };
}

/** `2 agents running`, `1 agent running`, `no agents running`. */
export function formatAgentsRunning(running: number): string {
  if (running === 0) return "no agents running";
  return `${running} agent${running === 1 ? "" : "s"} running`;
}

/** `1 building · 1 fix-and-merge` — only the kinds that have an agent. */
export function formatAgentKinds(byKind: Record<AgentKind, number>): string {
  return (Object.keys(AGENT_KIND_LABEL) as AgentKind[])
    .filter((kind) => byKind[kind] > 0)
    .map((kind) => `${byKind[kind]} ${AGENT_KIND_LABEL[kind]}`)
    .join(" · ");
}

/** The agents chip tooltip: the count, its split, and the definition. */
export function describeAgentActivity(agents: AgentActivity): string {
  const lines = [formatAgentsRunning(agents.running)];
  if (agents.running > 0) {
    lines[0] += `: ${formatAgentKinds(agents.byKind)}`;
    if (agents.byProfile.length > 0) {
      lines.push(`By profile: ${agents.byProfile.map((p) => `${p.profile} ${p.count}`).join(", ")}`);
    }
    if (agents.outsideInProgress > 0) {
      lines.push(`${agents.outsideInProgress} of them on tickets outside In Progress, so not in WIP.`);
    }
  }
  lines.push(PULSE_TERMS.agentsRunning);
  return lines.join("\n");
}

/** `3 todo · 4 in progress · 6 in review`, or `no open tickets`. */
export function formatTicketFlow(flow: readonly TicketFlowColumn[]): string {
  if (flow.length === 0) return "no open tickets";
  return flow.map((c) => `${c.count} ${c.label}`).join(" · ");
}

export function computeBoardStats(
  activeColumns: StatusWithIssues[],
  archiveColumns: StatusWithIssues[],
): BoardStatsData {
  const allColumns = [...activeColumns, ...archiveColumns];
  const totalActive = activeColumns.reduce((sum, col) => sum + col.count, 0);
  const totalArchive = archiveColumns.reduce((sum, col) => sum + col.count, 0);
  const total = totalActive + totalArchive;

  const doneCount = archiveColumns.find((c) => c.name === "Done")?.count ?? 0;
  const cancelledCount = archiveColumns.find((c) => c.name === "Cancelled")?.count ?? 0;
  const nonCancelledTotal = total - cancelledCount;
  const completionPct = nonCancelledTotal > 0 ? Math.round((doneCount / nonCancelledTotal) * 100) : 0;

  const ticketFlow = activeColumns
    .filter((col) => col.count > 0)
    .map((col) => ({ id: col.id, name: col.name, label: col.name.toLowerCase(), count: col.count }));

  return {
    allColumns,
    totalActive,
    totalArchive,
    total,
    doneCount,
    cancelledCount,
    nonCancelledTotal,
    completionPct,
    ticketFlow,
    // All columns: an agent can still be running on a ticket that was just moved to an archive column.
    agents: computeAgentActivity(allColumns),
  };
}
