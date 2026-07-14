import type { WorkspaceSetupRun, WorkspaceSymlinkRun, ServiceStackState } from "@agentic-kanban/shared";

// Pure row -> DTO projection for getWorkspaceDetails. The repository owns the two
// queries; this module owns turning the joined row + latest session into the
// WorkspaceDetails wire shape. Side-effect-free, so the (previously CC-36,
// DB-only-reachable) projection is now a directly-unit-testable seam.

export interface WorkspaceDetails {
  id: string;
  issueId: string;
  branch: string | null;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  requiresReview: boolean;
  thoroughReview: boolean;
  readyForMerge: boolean;
  status: string;
  claudeProfile: string | null;
  agentCommand: string | null;
  provider: string | null;
  model: string | null;
  pendingPlanPath: string | null;
  skillId: string | null;
  skillName: string | null;
  contextPrimer: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  scorecard: { score: number } | null;
  lastSessionAt: string | null;
  sessionStatus: string | null;
  lastSessionTriggerType: string | null;
  contextTokens: number | null;
  lastTool: string | null;
  latestSetup: WorkspaceSetupRun | null;
  latestSymlink: WorkspaceSymlinkRun | null;
  serviceState: ServiceStackState | null;
  createdAt: string;
  updatedAt: string;
  issue: { title: string; priority: string | null };
}

/** The columns getWorkspaceDetails selects (workspace + joined issue/skill). */
export interface WorkspaceDetailsRow {
  id: string;
  issueId: string;
  branch: string | null;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  requiresReview: boolean;
  thoroughReview: boolean;
  readyForMerge: boolean;
  status: string;
  claudeProfile: string | null;
  agentCommand: string | null;
  provider: string | null;
  model: string | null;
  pendingPlanPath: string | null;
  skillId: string | null;
  contextPrimer: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  conflictCacheHasConflicts: boolean | null;
  conflictCacheFiles: string | null;
  diffStatCacheFilesChanged: number | null;
  diffStatCacheInsertions: number | null;
  diffStatCacheDeletions: number | null;
  scorecardScore: number | null;
  latestSetupCommand: string | null;
  latestSetupState: string | null;
  latestSetupStartedAt: string | null;
  latestSetupEndedAt: string | null;
  latestSetupExitCode: number | null;
  latestSetupDurationMs: number | null;
  latestSetupStdoutTail: string | null;
  latestSetupStderrTail: string | null;
  latestSymlinkState: string | null;
  latestSymlinkStartedAt: string | null;
  latestSymlinkEndedAt: string | null;
  latestSymlinkDirs: string | null;
  latestSymlinkLinked: string | null;
  latestSymlinkSkipped: string | null;
  latestSymlinkFailed: string | null;
  latestSymlinkError: string | null;
  serviceState: string | null;
  createdAt: string;
  updatedAt: string;
  issueTitle: string;
  issuePriority: string | null;
  skillName: string | null;
}

/** The latest session fields the projection reads. */
export interface WorkspaceDetailsSession {
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerType: string | null;
  stats: string | null;
}

export function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

export function mapSymlinkRun(row: {
  latestSymlinkState: string | null;
  latestSymlinkStartedAt: string | null;
  latestSymlinkEndedAt: string | null;
  latestSymlinkDirs: string | null;
  latestSymlinkLinked: string | null;
  latestSymlinkSkipped: string | null;
  latestSymlinkFailed: string | null;
  latestSymlinkError: string | null;
}): WorkspaceSymlinkRun | null {
  if (!row.latestSymlinkState) return null;
  return {
    state: row.latestSymlinkState as WorkspaceSymlinkRun["state"],
    dirs: parseJsonArray<string>(row.latestSymlinkDirs, []),
    linked: parseJsonArray<string>(row.latestSymlinkLinked, []),
    skipped: parseJsonArray<string>(row.latestSymlinkSkipped, []),
    failed: parseJsonArray<{ dir: string; error: string }>(row.latestSymlinkFailed, []),
    startedAt: row.latestSymlinkStartedAt,
    endedAt: row.latestSymlinkEndedAt,
    error: row.latestSymlinkError,
  };
}

/** contextTokens (explicit, else input+cacheRead) and lastTool from a session stats blob. */
export function parseSessionContextAndTool(stats: string | null): { contextTokens: number | null; lastTool: string | null } {
  if (!stats) return { contextTokens: null, lastTool: null };
  try {
    const p = JSON.parse(stats) as Record<string, unknown>;
    const explicit = (p.contextTokens as number) ?? 0;
    const tokens = explicit || ((p.inputTokens as number) ?? 0) + ((p.cacheReadTokens as number) ?? 0);
    return {
      contextTokens: tokens || null,
      lastTool: typeof p.lastTool === "string" && p.lastTool ? p.lastTool : null,
    };
  } catch {
    return { contextTokens: null, lastTool: null };
  }
}

function mapCachedConflicts(row: WorkspaceDetailsRow): WorkspaceDetails["conflicts"] {
  if (row.conflictCacheHasConflicts === null || row.conflictCacheHasConflicts === undefined) return null;
  return { hasConflicts: row.conflictCacheHasConflicts, conflictingFiles: parseJsonArray<string>(row.conflictCacheFiles, []) };
}

function mapCachedDiffStats(row: WorkspaceDetailsRow): WorkspaceDetails["diffStats"] {
  if (row.diffStatCacheFilesChanged === null || row.diffStatCacheFilesChanged === undefined) return null;
  return { filesChanged: row.diffStatCacheFilesChanged, insertions: row.diffStatCacheInsertions ?? 0, deletions: row.diffStatCacheDeletions ?? 0 };
}

/** Parse the persisted ServiceStackState JSON, tolerating null/garbage. */
function mapServiceState(row: WorkspaceDetailsRow): ServiceStackState | null {
  if (!row.serviceState) return null;
  try {
    const parsed = JSON.parse(row.serviceState) as ServiceStackState;
    return parsed && typeof parsed === "object" && typeof parsed.composeProjectName === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function mapLatestSetup(row: WorkspaceDetailsRow): WorkspaceSetupRun | null {
  if (!row.latestSetupState) return null;
  return {
    command: row.latestSetupCommand,
    state: row.latestSetupState as WorkspaceSetupRun["state"],
    startedAt: row.latestSetupStartedAt,
    endedAt: row.latestSetupEndedAt,
    exitCode: row.latestSetupExitCode,
    durationMs: row.latestSetupDurationMs,
    stdoutTail: row.latestSetupStdoutTail,
    stderrTail: row.latestSetupStderrTail,
  };
}

/** Assemble the WorkspaceDetails DTO from a joined row and its latest session (or null). */
export function mapWorkspaceDetailsRow(row: WorkspaceDetailsRow, sess: WorkspaceDetailsSession | null): WorkspaceDetails {
  const { contextTokens, lastTool } = parseSessionContextAndTool(sess?.stats ?? null);
  return {
    id: row.id,
    issueId: row.issueId,
    branch: row.branch,
    workingDir: row.workingDir,
    baseBranch: row.baseBranch,
    isDirect: row.isDirect,
    planMode: row.planMode,
    includeVisualProof: row.includeVisualProof,
    requiresReview: row.requiresReview,
    thoroughReview: row.thoroughReview,
    readyForMerge: row.readyForMerge,
    status: row.status,
    claudeProfile: row.claudeProfile,
    agentCommand: row.agentCommand,
    provider: row.provider,
    model: row.model,
    pendingPlanPath: row.pendingPlanPath,
    skillId: row.skillId,
    skillName: row.skillName ?? null,
    contextPrimer: row.contextPrimer ?? null,
    closedAt: row.closedAt,
    mergedAt: row.mergedAt,
    conflicts: mapCachedConflicts(row),
    diffStats: mapCachedDiffStats(row),
    scorecard: row.scorecardScore !== null && row.scorecardScore !== undefined ? { score: row.scorecardScore } : null,
    lastSessionAt: sess ? (sess.status === "running" ? sess.startedAt : sess.endedAt) : null,
    sessionStatus: sess?.status ?? null,
    lastSessionTriggerType: sess?.triggerType ?? null,
    contextTokens,
    lastTool,
    latestSetup: mapLatestSetup(row),
    latestSymlink: mapSymlinkRun(row),
    serviceState: mapServiceState(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    issue: { title: row.issueTitle, priority: row.issuePriority },
  };
}
