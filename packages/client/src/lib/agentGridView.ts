import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { LiveSessionStats, TodoItem } from "./useBoardEvents.js";

// Pure view-model for AgentGrid: status/attention config, per-card derivations, and
// the grid-level agent partition / sort / sizing. No JSX, no hooks — so the logic
// that drives which card shows where (and how) is directly unit-testable, and the
// card components shrink to layout. Extracted from AgentGrid.tsx (FeaturedCard CC 42).

export const STARTABLE_STATUS_NAMES = new Set(["Backlog", "Todo"]);
export const MAX_HISTORY = 8;

export interface CardConfig {
  label: string;
  dot: string;
  ring: string;
  header: string;
  tier: "live" | "background";
}

export const WS_STATUS_CONFIG: Record<string, CardConfig> = {
  active:    { label: "Active",    dot: "bg-green-500 animate-pulse",  ring: "ring-green-400/40",  header: "from-green-50 dark:from-green-950/50",  tier: "live" },
  fixing:    { label: "Fixing",    dot: "bg-orange-500 animate-pulse", ring: "ring-orange-400/40", header: "from-orange-50 dark:from-orange-950/50", tier: "live" },
  reviewing: { label: "Reviewing", dot: "bg-accent-500 animate-pulse", ring: "ring-accent-400/30", header: "from-accent-50 dark:from-accent-950/40", tier: "background" },
  idle:      { label: "Idle",      dot: "bg-gray-400",                 ring: "ring-gray-300/30",   header: "from-stone-100 dark:from-stone-800/40", tier: "background" },
  closed:    { label: "Closed",    dot: "bg-gray-300",                 ring: "ring-gray-200/30",   header: "from-stone-100 dark:from-stone-800/40", tier: "background" },
};

export const STATUS_ORDER = ["active", "fixing", "reviewing", "idle"];

export type AttentionKind = "merge" | "conflict";

export const ATTENTION_CONFIG: Record<AttentionKind, { label: string; dot: string; ring: string; header: string }> = {
  merge:    { label: "Ready to merge", dot: "bg-emerald-500", ring: "ring-emerald-400/60", header: "from-emerald-50 dark:from-emerald-950/50" },
  conflict: { label: "Conflicts",      dot: "bg-red-500",     ring: "ring-red-400/60",     header: "from-red-50 dark:from-red-950/50" },
};

type WsMain = NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>;

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Status config, with an attention override (merge/conflict) layered on when present. */
export function resolveCardConfig(status: string, attention?: AttentionKind): CardConfig {
  const baseCfg = WS_STATUS_CONFIG[status] ?? WS_STATUS_CONFIG.idle;
  if (!attention) return baseCfg;
  const att = ATTENTION_CONFIG[attention];
  return { ...baseCfg, label: att.label, dot: att.dot, ring: att.ring, header: att.header };
}

export interface TodoSummary {
  done: number;
  total: number;
  inProgress: TodoItem | undefined;
  pending: TodoItem[];
}

export function summarizeTodos(todos?: TodoItem[]): TodoSummary {
  return {
    done: todos?.filter((t) => t.status === "completed").length ?? 0,
    total: todos?.length ?? 0,
    inProgress: todos?.find((t) => t.status === "in_progress"),
    pending: todos?.filter((t) => t.status === "pending") ?? [],
  };
}

/** Context tokens: live stats win, else the persisted summary value, else 0. */
export function resolveContextTokens(liveStats: LiveSessionStats | undefined, ws: Pick<WsMain, "contextTokens">): number {
  return liveStats?.contextTokens ?? ws.contextTokens ?? 0;
}

/** The activity lines to show in the featured feed, falling back to last message/tool. */
export function buildDisplayHistory(activityHistory: string[], ws: Pick<WsMain, "lastAssistantMessage" | "lastTool">): string[] {
  if (activityHistory.length > 0) return activityHistory;
  if (ws.lastAssistantMessage) return [ws.lastAssistantMessage];
  if (ws.lastTool) return [`Last: ${ws.lastTool}`];
  return [];
}

/** The single activity line for a compact card: live activity, else last message/tool. */
export function resolveActivityText(currentActivity: string | undefined, ws: Pick<WsMain, "lastAssistantMessage" | "lastTool">): string | null {
  return currentActivity || ws.lastAssistantMessage || (ws.lastTool ? `Last: ${ws.lastTool}` : null);
}

/** Whether an idle workspace is plan-only noise that carries no pending human action. */
function isPlanOnlyNoise(ws: WsMain): boolean {
  return ws.status === "idle" && !!ws.planOnlyWarning && !ws.readyForMerge && !ws.conflicts?.hasConflicts;
}

/** Workspaces awaiting a human action (idle + ready-to-merge or conflicting). */
export function isAttentionAgent(issue: IssueWithStatus): boolean {
  const ws = issue.workspaceSummary?.main;
  return ws?.status === "idle" && (ws.readyForMerge === true || ws.conflicts?.hasConflicts === true);
}

/** Visible, non-closed agents (plan-only noise filtered) sorted by status then live activity. */
export function selectVisibleAgents(columns: StatusWithIssues[], liveActivity: Record<string, string>): IssueWithStatus[] {
  return columns
    .flatMap((col) => col.issues)
    .filter((issue) => {
      const ws = issue.workspaceSummary?.main;
      if (!ws || ws.status === "closed") return false;
      return !isPlanOnlyNoise(ws);
    })
    .sort((a, b) => {
      const aOrder = STATUS_ORDER.indexOf(a.workspaceSummary?.main?.status ?? "idle");
      const bOrder = STATUS_ORDER.indexOf(b.workspaceSummary?.main?.status ?? "idle");
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aLive = liveActivity[a.id] ? 1 : 0;
      const bLive = liveActivity[b.id] ? 1 : 0;
      return bLive - aLive;
    });
}

export interface AgentPartition {
  attention: IssueWithStatus[];
  live: IssueWithStatus[];
  background: IssueWithStatus[];
}

/** Split agents into attention / live / background tiers (attention wins over tier). */
export function partitionAgents(agents: IssueWithStatus[]): AgentPartition {
  const attention = agents.filter(isAttentionAgent);
  const rest = agents.filter((i) => !isAttentionAgent(i));
  const tierOf = (i: IssueWithStatus) => WS_STATUS_CONFIG[i.workspaceSummary?.main?.status ?? ""]?.tier;
  return {
    attention,
    live: rest.filter((i) => tierOf(i) === "live"),
    background: rest.filter((i) => tierOf(i) !== "live"),
  };
}

export interface AgentCounts {
  attentionCount: number;
  liveCount: number;
  reviewingCount: number;
  idleCount: number;
}

export function computeAgentCounts(partition: AgentPartition): AgentCounts {
  const statusIs = (status: string) => (i: IssueWithStatus) => i.workspaceSummary?.main?.status === status;
  return {
    attentionCount: partition.attention.length,
    liveCount: partition.live.length,
    reviewingCount: partition.background.filter(statusIs("reviewing")).length,
    idleCount: partition.background.filter(statusIs("idle")).length,
  };
}

/** Empty drop-slots to show: capacity minus active agents, capped at 3, only when droppable. */
export function computeEmptySlotCount(
  agents: IssueWithStatus[],
  activeAgentsTarget: number | undefined,
  hasDropHandler: boolean,
): number {
  const activeAgentCount = agents.filter((i) => {
    const s = i.workspaceSummary?.main?.status;
    return s === "active" || s === "fixing";
  }).length;
  if (!hasDropHandler || !activeAgentsTarget || activeAgentsTarget <= activeAgentCount) return 0;
  return Math.min(activeAgentsTarget - activeAgentCount, 3);
}

export interface GridSizing {
  featuredCount: number;
  featuredMinPx: number;
  compactMinPx: number;
}

export function computeGridSizing(partition: AgentPartition, emptySlotCount: number): GridSizing {
  const featuredCount = Math.max(partition.attention.length, partition.live.length + emptySlotCount);
  return {
    featuredCount,
    featuredMinPx: featuredCount <= 2 ? 320 : featuredCount <= 4 ? 280 : 240,
    compactMinPx: partition.background.length <= 6 ? 220 : partition.background.length <= 12 ? 190 : 165,
  };
}
