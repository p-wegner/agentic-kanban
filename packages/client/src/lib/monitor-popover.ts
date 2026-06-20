export type MonitorTunables = {
  activeAgentsTarget: number;
  backlogFloor: number;
  maxNewStartsPerCycle: number;
  refillFocus: string;
};

export type StartMode = "manual" | "monitor" | "conductor";

export type StartPolicy = {
  mode: StartMode;
  autoStartUnblocked: boolean;
  postMergeCascade: boolean;
  backlogRefill: boolean;
  scheduledRuns: boolean;
  source: "start_mode" | "derived";
};

export type ResolvedTunables = {
  tunables: MonitorTunables;
  source: "strategy" | "prefs";
  startPolicy?: StartPolicy;
};

export type ConductorSchedule = {
  enabled: boolean;
  cron: string;
  agent: "claude" | "codex";
  lastFiredAt: string | null;
  valid: boolean;
  error: string | null;
  description: string | null;
  nextFireAt: string | null;
};

export type DirtyMainCheckoutWarning = {
  projectId: string;
  projectName: string;
  repoPath: string;
  detectedAt: string;
  fileCount: number;
  files: string[];
  message: string;
};

export type AutodriveStallWarning = {
  type: "autodrive_stall";
  projectId: string;
  projectName: string;
  detectedAt: string;
  thresholdMin: number;
  stalledForMin: number;
  lastProgressAt: string;
  activeIssueCount: number;
  workspaceIds: string[];
  issueNumbers: number[];
  cause: string;
  message: string;
};

export type MonitorWarning = DirtyMainCheckoutWarning | AutodriveStallWarning;

export function isAutodriveStallWarning(warning: MonitorWarning): warning is AutodriveStallWarning {
  return "type" in warning && warning.type === "autodrive_stall";
}

export const START_MODE_LABEL: Record<StartMode, string> = { manual: "Manual", monitor: "Monitor", conductor: "Conductor" };
export const START_MODE_HINT: Record<StartMode, string> = {
  manual: "Nothing auto-starts. Only you / agents start workspaces explicitly.",
  monitor: "The in-process monitor auto-starts unblocked backlog tickets up to the WIP target.",
  conductor: "The out-of-process board-monitor loop is the sole driver; the in-process monitor stands down.",
};

export type MonitorAction = {
  at: string;
  action: "relaunch" | "merge" | "nudge" | "mark_idle" | "mark_dead" | "auto_start" | "generate_tickets";
  workspaceId: string;
  issueId: string;
  /** HTTP endpoint called for this action, e.g. /api/workspaces/:id/merge */
  endpoint?: string;
  /** HTTP response status code */
  httpStatus?: number;
  /** Truncated response body summary */
  responseSummary?: string;
  /** Post-action verification result */
  verificationResult?: "ok" | "failed" | "skipped";
};

export type MonitorStatus = {
  enabled: boolean;
  intervalMin: number;
  active: boolean;
  lastRun: {
    at: string;
    relaunched: number;
    merged: number;
    nudged: number;
    resources?: {
      processCount: number;
      listenerCount: number;
      activeWorkspaceCount: number;
      keptCount: number;
      cleanedCount: number;
      cleanupFailedCount: number;
    } | null;
    warnings?: number;
  } | null;
  nextRunAt: string | null;
  recentActions: MonitorAction[];
  warnings?: MonitorWarning[];
  lastHealthCheckAt?: string | null;
  resourceSnapshot?: {
    at: string;
    kept: Array<{ rootPid: number; pids: number[]; listenerPorts: number[]; associatedWorkspaceIds: string[]; reason: string }>;
    cleaned: Array<{ rootPid: number; pids: number[]; listenerPorts: number[]; associatedWorkspaceIds: string[]; action: "cleaned" | "cleanup_failed"; reason: string }>;
  } | null;
};

export type BoardHealthEvent = {
  id: string;
  timestamp: string;
  level: "info" | "error";
  type: "cycle_start" | "cycle_end" | "observation" | "action" | "error";
  category: "merge" | "launch" | "server" | "refill" | "smoke_check" | null;
  issueNumber: number | null;
  summary: string;
  details: string | null;
};

export function parseCycleLine(line: string): { age: string | null; text: string } {
  // Format: "<ISO time> | <action> | <items>". Be lenient.
  const parts = line.split("|").map((p) => p.trim());
  if (parts.length >= 2) {
    const ts = new Date(parts[0]);
    const age = Number.isNaN(ts.getTime()) ? null : parts[0];
    return { age, text: parts.slice(1).join(" · ") };
  }
  return { age: null, text: line };
}
