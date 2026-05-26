import { workspaces, sessions, sessionMessages, issues, projectStatuses, issueDependencies, tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, inArray, sql, desc } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { getDiffShortstat, detectConflicts } from "./git.service.js";
import type { ProviderName } from "./agent-provider.js";

// Limit concurrent background git operations to avoid hammering the filesystem
let _bgGitRunning = 0;
const BG_GIT_CONCURRENCY = 5;

function runBgGit(fn: () => Promise<void>): void {
  if (_bgGitRunning >= BG_GIT_CONCURRENCY) return;
  _bgGitRunning++;
  fn().finally(() => { _bgGitRunning--; });
}

const CONFLICT_CACHE_TTL_MS = 5 * 60 * 1000;
const DIFF_STAT_CACHE_TTL_MS = 30 * 1000;

type WorkspaceSummary = {
  total: number;
  active: number;
  idle: number;
  closed: number;
  branches: string[];
  main?: {
    id: string;
    branch: string;
    status: "active" | "reviewing" | "fixing" | "idle" | "error" | "closed";
    claudeProfile: string | null;
    profile?: { provider: ProviderName; name: string } | null;
    agentCommand: string | null;
    readyForMerge?: boolean;
    planMode?: boolean;
    diffStats?: { filesChanged: number; insertions: number; deletions: number } | null;
    conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
    lastSessionAt?: string | null;
    lastSessionTriggerType?: string | null;
    contextTokens?: number | null;
    lastTool?: string | null;
    lastAssistantMessage?: string | null;
    pendingPlanPath?: string | null;
    planOnlyWarning?: boolean;
  };
};

export async function buildWorkspaceSummaryMap(
  issueIds: string[],
  defaultBranch: string | null,
  database: Database,
): Promise<Map<string, WorkspaceSummary>> {
  const workspaceSummaryMap = new Map<string, WorkspaceSummary>();
  if (issueIds.length === 0) return workspaceSummaryMap;

  // Aggregate counts per issue+status
  const wsRows = await database
    .select({
      issueId: workspaces.issueId,
      status: workspaces.status,
      branch: workspaces.branch,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds))
    .groupBy(workspaces.issueId, workspaces.status, workspaces.branch);

  for (const row of wsRows) {
    let summary = workspaceSummaryMap.get(row.issueId);
    if (!summary) {
      summary = { total: 0, active: 0, idle: 0, closed: 0, branches: [] };
      workspaceSummaryMap.set(row.issueId, summary);
    }
    summary.total += row.count;
    if (row.status === "active" || row.status === "reviewing" || row.status === "fixing") {
      summary.active += row.count;
    } else if (row.status === "closed") {
      summary.closed += row.count;
    } else {
      summary.idle += row.count;
    }
    if (!summary.branches.includes(row.branch)) {
      summary.branches.push(row.branch);
    }
  }

  // Fetch workspace detail rows to determine main workspace per issue
  const wsDetailRows = await database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      updatedAt: workspaces.updatedAt,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      pendingPlanPath: workspaces.pendingPlanPath,
      planMode: workspaces.planMode,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      conflictCacheCheckedAt: workspaces.conflictCacheCheckedAt,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      readyForMerge: workspaces.readyForMerge,
      diffStatCacheCheckedAt: workspaces.diffStatCacheCheckedAt,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));

  // Pick main workspace per issue: active > idle > closed, tie-break by updatedAt
  const statusPriority = (s: string) => s === "active" || s === "reviewing" || s === "fixing" ? 0 : s === "idle" ? 1 : 2;
  type MainWs = typeof wsDetailRows[number];
  const mainWorkspaceMap = new Map<string, MainWs>();
  for (const row of wsDetailRows) {
    const existing = mainWorkspaceMap.get(row.issueId);
    if (!existing) { mainWorkspaceMap.set(row.issueId, row); continue; }
    const existingP = statusPriority(existing.status);
    const rowP = statusPriority(row.status);
    if (rowP < existingP || (rowP === existingP && row.updatedAt > existing.updatedAt)) {
      mainWorkspaceMap.set(row.issueId, row);
    }
  }

  // Attach main workspace summary and schedule stale-while-revalidate cache refreshes
  for (const [issueId, summary] of workspaceSummaryMap) {
    const mainWs = mainWorkspaceMap.get(issueId);
    if (!mainWs) continue;

    summary.main = {
      id: mainWs.id,
      branch: mainWs.branch,
      status: mainWs.status as "active" | "reviewing" | "fixing" | "idle" | "error" | "closed",
      claudeProfile: mainWs.claudeProfile,
      profile: mainWs.claudeProfile ? { provider: (mainWs.provider as ProviderName) ?? "claude", name: mainWs.claudeProfile } : null,
      agentCommand: mainWs.agentCommand,
      readyForMerge: mainWs.readyForMerge,
      planMode: mainWs.planMode,
      pendingPlanPath: mainWs.pendingPlanPath,
      planOnlyWarning: false,
    };

    if (mainWs.workingDir && mainWs.status !== "closed") {
      const diffRef = mainWs.isDirect ? "HEAD" : (mainWs.baseBranch || defaultBranch);
      if (!diffRef) continue;
      const mainRef = summary.main;

      // Serve cached diff stats immediately
      if (mainWs.diffStatCacheCheckedAt && mainWs.diffStatCacheFilesChanged !== null) {
        if (mainWs.diffStatCacheFilesChanged > 0 || (mainWs.diffStatCacheInsertions ?? 0) > 0 || (mainWs.diffStatCacheDeletions ?? 0) > 0) {
          mainRef.diffStats = {
            filesChanged: mainWs.diffStatCacheFilesChanged,
            insertions: mainWs.diffStatCacheInsertions ?? 0,
            deletions: mainWs.diffStatCacheDeletions ?? 0,
          };
        }
      }

      // Detect plan-only sessions: idle workspace with 0 diff changes that wasn't explicitly in plan mode
      if (mainWs.status === "idle" && !mainWs.planMode && mainWs.diffStatCacheCheckedAt) {
        const hasChanges = (mainWs.diffStatCacheFilesChanged ?? 0) > 0
          || (mainWs.diffStatCacheInsertions ?? 0) > 0
          || (mainWs.diffStatCacheDeletions ?? 0) > 0;
        if (!hasChanges) {
          mainRef.planOnlyWarning = true;
        }
      }

      // Background refresh if cache is stale or missing
      const diffCacheAge = mainWs.diffStatCacheCheckedAt
        ? Date.now() - new Date(mainWs.diffStatCacheCheckedAt).getTime()
        : Infinity;
      if (diffCacheAge >= DIFF_STAT_CACHE_TTL_MS) {
        const wsId = mainWs.id;
        const workingDir = mainWs.workingDir;
        runBgGit(() =>
          getDiffShortstat(workingDir, diffRef)
            .then(stats => {
              database.update(workspaces).set({
                diffStatCacheCheckedAt: new Date().toISOString(),
                diffStatCacheFilesChanged: stats.filesChanged,
                diffStatCacheInsertions: stats.insertions,
                diffStatCacheDeletions: stats.deletions,
              }).where(eq(workspaces.id, wsId)).catch(() => {});
            })
            .catch(() => {})
        );
      }

      // Conflict detection for non-direct idle workspaces — stale-while-revalidate
      if (!mainWs.isDirect && mainWs.status === "idle") {
        const conflictCacheAge = mainWs.conflictCacheCheckedAt
          ? Date.now() - new Date(mainWs.conflictCacheCheckedAt).getTime()
          : Infinity;
        if (mainWs.conflictCacheCheckedAt && conflictCacheAge < CONFLICT_CACHE_TTL_MS) {
          if (mainWs.conflictCacheHasConflicts !== null) {
            mainRef.conflicts = {
              hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
              conflictingFiles: mainWs.conflictCacheFiles ? JSON.parse(mainWs.conflictCacheFiles) : [],
            };
          }
        } else {
          if (mainWs.conflictCacheCheckedAt && mainWs.conflictCacheHasConflicts !== null) {
            mainRef.conflicts = {
              hasConflicts: mainWs.conflictCacheHasConflicts ?? false,
              conflictingFiles: mainWs.conflictCacheFiles ? JSON.parse(mainWs.conflictCacheFiles) : [],
            };
          }
          const wsId = mainWs.id;
          const baseBranch = mainWs.baseBranch || defaultBranch;
          if (!baseBranch) continue;
          const workingDir = mainWs.workingDir;
          runBgGit(() =>
            detectConflicts(workingDir, baseBranch)
              .then(result => {
                database.update(workspaces).set({
                  conflictCacheCheckedAt: new Date().toISOString(),
                  conflictCacheHasConflicts: result.hasConflicts,
                  conflictCacheFiles: JSON.stringify(result.conflictingFiles),
                }).where(eq(workspaces.id, wsId)).catch(() => {});
              })
              .catch(() => {})
          );
        }
      }
    }
  }

  // Fetch latest session per main workspace for timing + last output info
  const mainWsIds = [...mainWorkspaceMap.values()].map(w => w.id);
  if (mainWsIds.length > 0) {
    const sessionRows = await database
      .select({
        id: sessions.id,
        workspaceId: sessions.workspaceId,
        status: sessions.status,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        stats: sessions.stats,
        triggerType: sessions.triggerType,
      })
      .from(sessions)
      .where(inArray(sessions.workspaceId, mainWsIds))
      .orderBy(sessions.startedAt);

    const latestByWs = new Map<string, { id: string; status: string; startedAt: string; endedAt: string | null; stats: string | null; triggerType: string | null }>();
    for (const s of sessionRows) {
      latestByWs.set(s.workspaceId, { id: s.id, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, stats: s.stats, triggerType: s.triggerType ?? null });
    }

    const latestSessionIds = [...latestByWs.values()].map(s => s.id);
    const lastToolBySession = new Map<string, string>();
    const lastAssistantMsgBySession = new Map<string, string>();

    if (latestSessionIds.length > 0) {
      const msgRows = await database
        .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
        .from(sessionMessages)
        .where(inArray(sessionMessages.sessionId, latestSessionIds))
        .orderBy(desc(sessionMessages.id));

      for (const msg of msgRows) {
        const hasTool = lastToolBySession.has(msg.sessionId);
        const hasMsg = lastAssistantMsgBySession.has(msg.sessionId);
        if (hasTool && hasMsg) continue;
        if (!msg.data) continue;
        try {
          const obj = JSON.parse(msg.data) as Record<string, unknown>;
          if (obj.type === "assistant") {
            const content = (obj.message as { content?: unknown[] })?.content ?? [];
            for (const block of content as { type: string; name?: string; text?: string; input?: unknown }[]) {
              if (!hasTool && block.type === "tool_use" && block.name) {
                lastToolBySession.set(msg.sessionId, block.name);
              }
              if (!hasMsg && block.type === "text" && block.text?.trim()) {
                lastAssistantMsgBySession.set(msg.sessionId, block.text.trim());
              }
            }
          }
          // Copilot stream: assistant.message
          if (obj.type === "assistant.message" && !hasMsg) {
            const data = obj.data as Record<string, unknown> | undefined;
            if (data) {
              const raw = data.content;
              const contentStr = typeof raw === "string" ? raw
                : Array.isArray(raw)
                  ? (raw as { type?: string; text?: string }[])
                      .filter(b => b.type === "text" && typeof b.text === "string")
                      .map(b => b.text as string)
                      .join("\n")
                  : "";
              if (contentStr.trim()) {
                lastAssistantMsgBySession.set(msg.sessionId, contentStr.trim());
              }
            }
          }
        } catch { /* ignore */ }
      }
    }

    for (const [, summary] of workspaceSummaryMap) {
      if (!summary.main) continue;
      const sess = latestByWs.get(summary.main.id);
      if (!sess) continue;
      summary.main.lastSessionAt = sess.status === "running" ? sess.startedAt : sess.endedAt;
      summary.main.lastSessionTriggerType = sess.triggerType;
      if (sess.stats) {
        try {
          const p = JSON.parse(sess.stats) as Record<string, unknown>;
          const inputTokens = (p.inputTokens as number) ?? 0;
          const cachedTokens = (p.cacheReadTokens as number) ?? 0;
          summary.main.contextTokens = inputTokens + cachedTokens || null;
        } catch { /* ignore */ }
      }
      summary.main.lastTool = lastToolBySession.get(sess.id) ?? null;
      summary.main.lastAssistantMessage = lastAssistantMsgBySession.get(sess.id) ?? null;
    }
  }

  return workspaceSummaryMap;
}

/**
 * For a list of workspace IDs, query their latest sessions and return:
 * - contextTokens per workspace (input + cache-read tokens from session stats)
 * - lastTool per workspace (name of last tool_use block in session messages)
 */
export async function enrichWorkspacesWithSessionData(
  wsIds: string[],
  database: Database,
): Promise<{ contextTokensMap: Map<string, number>; lastToolMap: Map<string, string> }> {
  const contextTokensMap = new Map<string, number>();
  const lastToolMap = new Map<string, string>();

  if (wsIds.length === 0) return { contextTokensMap, lastToolMap };

  const sessRows = await database
    .select({ id: sessions.id, workspaceId: sessions.workspaceId, stats: sessions.stats })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(sessions.startedAt);

  const latestByWs = new Map<string, { id: string; stats: string | null }>();
  for (const s of sessRows) latestByWs.set(s.workspaceId, { id: s.id, stats: s.stats });

  for (const [wsId, sess] of latestByWs) {
    if (sess.stats) {
      try {
        const p = JSON.parse(sess.stats) as Record<string, unknown>;
        const tokens = ((p.inputTokens as number) ?? 0) + ((p.cacheReadTokens as number) ?? 0);
        if (tokens) contextTokensMap.set(wsId, tokens);
      } catch { /* ignore */ }
    }
  }

  const sessIds = [...latestByWs.values()].map(s => s.id);
  if (sessIds.length > 0) {
    const msgRows = await database
      .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, sessIds))
      .orderBy(desc(sessionMessages.id));

    const sessionToWs = new Map<string, string>();
    for (const [wsId, sess] of latestByWs) sessionToWs.set(sess.id, wsId);

    for (const msg of msgRows) {
      const wsId = sessionToWs.get(msg.sessionId);
      if (!wsId || lastToolMap.has(wsId) || !msg.data) continue;
      try {
        const obj = JSON.parse(msg.data) as Record<string, unknown>;
        if (obj.type === "assistant") {
          const content = (obj.message as { content?: unknown[] })?.content ?? [];
          for (const block of content as { type: string; name?: string }[]) {
            if (block.type === "tool_use" && block.name) {
              lastToolMap.set(wsId, block.name);
              break;
            }
          }
        }
        // Copilot stream: tool names are in assistant.message data.toolRequests
        if (obj.type === "assistant.message" && !lastToolMap.has(wsId)) {
          const data = obj.data as Record<string, unknown> | undefined;
          const toolRequests = Array.isArray(data?.toolRequests) ? data!.toolRequests : [];
          for (const tr of toolRequests as { name?: string }[]) {
            if (tr.name) {
              lastToolMap.set(wsId, tr.name);
              break;
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  return { contextTokensMap, lastToolMap };
}

export async function buildBlockedMap(
  issueIds: string[],
  database: Database,
): Promise<Map<string, { isBlocked: boolean; dependencyCount: number }>> {
  const result = new Map<string, { isBlocked: boolean; dependencyCount: number }>();
  if (issueIds.length === 0) return result;

  const depRows = await database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(inArray(issueDependencies.issueId, issueIds));

  const dependsOnIds = [...new Set(depRows.map(d => d.dependsOnId))];
  const depStatusMap = new Map<string, string>();
  if (dependsOnIds.length > 0) {
    const depStatuses = await database
      .select({ id: issues.id, statusName: projectStatuses.name })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(inArray(issues.id, dependsOnIds));
    for (const ds of depStatuses) depStatusMap.set(ds.id, ds.statusName);
  }

  const depsByIssue = new Map<string, { dependsOnId: string; type: string }[]>();
  for (const dep of depRows) {
    let arr = depsByIssue.get(dep.issueId);
    if (!arr) { arr = []; depsByIssue.set(dep.issueId, arr); }
    arr.push({ dependsOnId: dep.dependsOnId, type: dep.type });
  }

  for (const [issueId, deps] of depsByIssue) {
    const isBlocked = deps.some(dep => {
      if (dep.type !== "depends_on" && dep.type !== "blocked_by") return false;
      const s = depStatusMap.get(dep.dependsOnId);
      return s !== "Done" && s !== "AI Reviewed";
    });
    result.set(issueId, { isBlocked, dependencyCount: deps.length });
  }

  return result;
}

export async function buildTagMap(
  issueIds: string[],
  database: Database,
): Promise<Map<string, { id: string; name: string; color: string | null }[]>> {
  const tagMap = new Map<string, { id: string; name: string; color: string | null }[]>();
  if (issueIds.length === 0) return tagMap;

  const tagRows = await database
    .select({ issueId: issueTags.issueId, id: tags.id, name: tags.name, color: tags.color })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(inArray(issueTags.issueId, issueIds));

  for (const row of tagRows) {
    let arr = tagMap.get(row.issueId);
    if (!arr) { arr = []; tagMap.set(row.issueId, arr); }
    arr.push({ id: row.id, name: row.name, color: row.color });
  }

  return tagMap;
}

export type GraphEdge = {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
};

/** Fetch all dependency edges for a set of issue IDs. */
export async function buildGraphEdges(issueIds: string[], database: Database): Promise<GraphEdge[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      issueNumber: issues.issueNumber,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(inArray(issueDependencies.issueId, issueIds));
}

/**
 * DFS cycle check. Returns true if adding the edge issueId->dependsOnId would
 * create a cycle in the project dependency graph.
 */
export async function wouldCreateCycle(database: Database, issueId: string, dependsOnId: string, projectId: string): Promise<boolean> {
  const allDeps = await database
    .select({
      depIssueId: issueDependencies.issueId,
      depDependsOnId: issueDependencies.dependsOnId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));

  const adj = new Map<string, Set<string>>();
  for (const dep of allDeps) {
    let set = adj.get(dep.depIssueId);
    if (!set) { set = new Set(); adj.set(dep.depIssueId, set); }
    set.add(dep.depDependsOnId);
  }

  const visited = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === issueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const neighbors = adj.get(current);
    if (neighbors) {
      for (const n of neighbors) stack.push(n);
    }
  }
  return false;
}

/** Parse basic stats from unified diff output. */
export function parseDiffStats(diff: string): { filesChanged: number; insertions: number; deletions: number } {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
      filesChanged++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      insertions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return { filesChanged, insertions, deletions };
}
