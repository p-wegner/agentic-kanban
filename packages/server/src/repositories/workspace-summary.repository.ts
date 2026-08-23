import { workspaces, sessions, sessionMessages, showdowns, workflowEdges, workflowNodes, repos, issues, workspaceCodeMetrics, workspaceConflictCache, workspaceSummary, workspaceDiffStatCache, workspaceScorecard } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, sql, desc } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { sessionLifecycleColumns } from "./projections.js";

/**
 * The workspace's LEADING repo row (#222 stage 1, migration 0110). Aliased so the join
 * cannot pick up this workspace's SIBLING rows and multiply the result by them.
 */
const leadingRepo = alias(repos, "leading_repo");

/** Join predicate for {@link leadingRepo}. */
const onLeadingRepo = and(eq(leadingRepo.workspaceId, workspaces.id), eq(leadingRepo.isLeading, true));

export async function aggregateWorkspaceCountRows(issueIds: string[], database: Database = db) {
  return database
    .select({
      issueId: workspaces.issueId,
      status: workspaces.status,
      // #225 — branch comes from the leading repo row; the mirror column is only a fallback
      // until stage 4 drops it (see workspace-reads.repository.ts for the full rationale).
      branch: sql<string>`coalesce(${leadingRepo.branch}, ${workspaces.branch})`,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(workspaces)
    .leftJoin(leadingRepo, onLeadingRepo)
    .where(inArray(workspaces.issueId, issueIds))
    .groupBy(workspaces.issueId, workspaces.status, sql`coalesce(${leadingRepo.branch}, ${workspaces.branch})`);
}

export async function fetchWorkspaceDetailRows(issueIds: string[], database: Database = db) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      // #225 — leading repo row first, mirror columns only as the stage-4 fallback.
      branch: sql<string>`coalesce(${leadingRepo.branch}, ${workspaces.branch})`,
      status: workspaces.status,
      updatedAt: workspaces.updatedAt,
      claudeProfile: workspaces.claudeProfile,
      agentCommand: workspaces.agentCommand,
      provider: workspaces.provider,
      model: workspaces.model,
      pendingPlanPath: workspaces.pendingPlanPath,
      planMode: workspaces.planMode,
      workingDir: sql<string | null>`coalesce(${leadingRepo.worktreePath}, ${workspaces.workingDir})`,
      baseBranch: sql<string | null>`coalesce(${leadingRepo.baseBranch}, ${workspaces.baseBranch})`,
      isDirect: workspaces.isDirect,
      // #399 (decision 014) — the persisted git projection, served on the hot path.
      // #815: it moved to `workspace_summary`. Aliased back to the same five field names, so
      // every consumer of this projected row is untouched by the move. `summaryDirty` is
      // COALESCED because a workspace with no row is DIRTY, not clean — the dropped column
      // was NOT NULL DEFAULT TRUE, which inverts the absence-is-neutral convention the other
      // extracted families use. `.mapWith(Boolean)` is load-bearing: a raw `sql` expression
      // bypasses the column's `{ mode: "boolean" }` mapping and would hand every consumer
      // SQLite's 1/0 under a `boolean` type — a `=== false` check away from a silent bug.
      summaryHeadSha: workspaceSummary.headSha,
      summaryHeadMessage: workspaceSummary.headMessage,
      summaryCommitCount: workspaceSummary.commitCount,
      summaryGitRefreshedAt: workspaceSummary.gitRefreshedAt,
      summaryDirty: sql<boolean>`coalesce(${workspaceSummary.dirty}, 1)`.mapWith(Boolean),
      // #815: the conflict memo moved to `workspace_conflict_cache`. Aliased back to the same
      // field names, so every consumer of this projected row is untouched by the move.
      conflictCacheCheckedAt: workspaceConflictCache.checkedAt,
      conflictCacheHasConflicts: workspaceConflictCache.hasConflicts,
      conflictCacheFiles: workspaceConflictCache.files,
      readyForMerge: workspaces.readyForMerge,
      // #815: the diff-stat memo moved to `workspace_diff_stat_cache`. Aliased back to the
      // same five field names, so every consumer of this projected row is untouched by the
      // move. No `coalesce` here, unlike `summaryDirty` above: all five dropped columns were
      // nullable with no default, so the LEFT JOIN's own NULLs ARE the previous semantics.
      diffStatCacheCheckedAt: workspaceDiffStatCache.checkedAt,
      diffStatCacheHeadSha: workspaceDiffStatCache.headSha,
      diffStatCacheFilesChanged: workspaceDiffStatCache.filesChanged,
      diffStatCacheInsertions: workspaceDiffStatCache.insertions,
      diffStatCacheDeletions: workspaceDiffStatCache.deletions,
      // #815: the scorecard artifact moved to `workspace_scorecard`. Aliased back to the same
      // field name, so every consumer of this projected row is untouched by the move.
      scorecardScore: workspaceScorecard.score,
      // #798: the artifact moved to `workspace_code_metrics`. Aliased back to the same two
      // field names, so every consumer of this projected row is untouched by the move.
      codeMetricsJson: workspaceCodeMetrics.metricsJson,
      codeMetricsComputedAt: workspaceCodeMetrics.computedAt,
      currentNodeId: workspaces.currentNodeId,
      showdownId: workspaces.showdownId,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .leftJoin(leadingRepo, onLeadingRepo)
    .leftJoin(workspaceCodeMetrics, eq(workspaceCodeMetrics.workspaceId, workspaces.id))
    // #815: LEFT, not inner — a never-probed workspace has no memo row and must still be
    // returned, or the board silently loses every workspace it has not yet gitted.
    .leftJoin(workspaceConflictCache, eq(workspaceConflictCache.workspaceId, workspaces.id))
    // #815: LEFT, not inner — a never-projected workspace has no summary row and must still be
    // returned (dirty by absence), or the board silently loses every brand-new workspace.
    .leftJoin(workspaceSummary, eq(workspaceSummary.workspaceId, workspaces.id))
    // #815: LEFT, not inner — a never-diffed workspace has no memo row and must still be
    // returned, or the board silently loses every workspace it has not yet diffed.
    .leftJoin(workspaceDiffStatCache, eq(workspaceDiffStatCache.workspaceId, workspaces.id))
    // #815: LEFT, not inner — a workspace whose first session has not ended yet has no
    // scorecard row and must still be returned, which is most of the board at any moment.
    .leftJoin(workspaceScorecard, eq(workspaceScorecard.workspaceId, workspaces.id))
    .where(inArray(workspaces.issueId, issueIds));
}

export async function getShowdownStatuses(showdownIds: string[], database: Database = db) {
  return database
    .select({ id: showdowns.id, status: showdowns.status })
    .from(showdowns)
    .where(inArray(showdowns.id, showdownIds));
}

// #815: `updateWorkspaceConflictCache` moved to `repositories/conflict-cache.repository.ts`
// and `updateWorkspaceDiffStatCache` to `repositories/diff-stat-cache.repository.ts`,
// together with the columns each wrote — both memos have their own table and their own owner
// now. This file is left with reads only, so it no longer writes `workspaces` at all.

export async function getWorkflowNodesByIds(nodeIds: string[], database: Database = db) {
  return database
    .select({
      id: workflowNodes.id,
      name: workflowNodes.name,
      nodeType: workflowNodes.nodeType,
      statusName: workflowNodes.statusName,
    })
    .from(workflowNodes)
    .where(inArray(workflowNodes.id, nodeIds));
}

export async function getOutgoingWorkflowEdges(fromNodeIds: string[], database: Database = db) {
  return database
    .select({
      fromNodeId: workflowEdges.fromNodeId,
      toNodeId: workflowEdges.toNodeId,
      sortOrder: workflowEdges.sortOrder,
    })
    .from(workflowEdges)
    .where(inArray(workflowEdges.fromNodeId, fromNodeIds));
}

export async function getWorkflowNodeNamesByIds(nodeIds: string[], database: Database = db) {
  return database
    .select({ id: workflowNodes.id, name: workflowNodes.name })
    .from(workflowNodes)
    .where(inArray(workflowNodes.id, nodeIds));
}

/**
 * G9 (2026-08-11 read-path audit): this select deliberately EXCLUDES `stats`.
 * It fetches every session row of every main workspace (unbounded by design —
 * the caller's latest-per-workspace selection needs the full ordered set for
 * its noise-fallback semantics), but the caller keeps ~1 row per workspace, so
 * shipping every historical session's `stats` JSON blob was pure waste. Stats
 * are fetched separately for just the winner rows via {@link getSessionStatsByIds}.
 */
export async function getSessionsForWorkspaces(workspaceIds: string[], database: Database = db) {
  return database
    .select({
      ...sessionLifecycleColumns,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(sessions.startedAt);
}

/** The `stats` blobs for the latest-per-workspace winner sessions only (G9). */
export async function getSessionStatsByIds(sessionIds: string[], database: Database = db) {
  if (sessionIds.length === 0) return [];
  return database
    .select({ id: sessions.id, stats: sessions.stats })
    .from(sessions)
    .where(inArray(sessions.id, sessionIds));
}

/**
 * Distinct owning project ids for a set of workspaces (G13) — resolves which
 * board ETag generations a batch of background write-throughs invalidates.
 */
export async function getProjectIdsForWorkspaces(workspaceIds: string[], database: Database = db): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await database
    .selectDistinct({ projectId: issues.projectId })
    .from(workspaces)
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    .where(inArray(workspaces.id, workspaceIds));
  return rows.map((r) => r.projectId).filter((p): p is string => !!p);
}

/**
 * How many of the newest rows per session the DB fallback fetches (#401). The caller
 * (workspace-summary.service collectLastToolAndMessages) walks rows newest-first and
 * keeps only the FIRST tool name + FIRST assistant message it finds per session, so
 * pulling a session's ENTIRE message history (data payload included — megabytes for a
 * long session) was pure waste. Tool/assistant events occur every few rows in practice;
 * 50 newest rows is generous (same bound monitor-helpers' DB fallback uses). The only
 * semantic difference from the unbounded query: a session whose newest 50 rows contain
 * no extractable event now yields null instead of an ancient match — acceptable for a
 * field named `lastTool` / `lastAssistantMessage`.
 */
const PER_SESSION_MESSAGE_LIMIT = 50;

/** Bounded fan-out for the per-session fallback queries (G14c) — mirrors the
 * tail-read sibling's TAIL_READ_CONCURRENCY so a temp sweep that strands ~W
 * workspaces on the DB fallback doesn't fire W parallel queries in one tick. */
const PER_SESSION_QUERY_CONCURRENCY = 5;

export async function getSessionMessagesForSessions(sessionIds: string[], database: Database = db) {
  // One bounded query per session instead of one unbounded query for all sessions:
  // each per-session query is served by the (session_id, id) index from migration 0113
  // (index-ordered DESC scan, stops after LIMIT rows — no temp B-tree sort, no full
  // payload materialization). Rows stay newest-first within each session, which is the
  // ordering the caller's first-match-wins extraction depends on; interleaving across
  // sessions never mattered (extraction state is keyed by sessionId).
  //
  // G14c: the per-session queries run through a small worker pool instead of an
  // uncapped Promise.all — same bound as the .out tail-read sibling.
  type MessageRow = { sessionId: string; data: string | null };
  // `new Array(n)` is typed `any[]` — give it the element type so the slot assignments below
  // are checked rather than silently `any`.
  const results = new Array<MessageRow[]>(sessionIds.length);
  let nextIdx = 0;
  const worker = async (): Promise<void> => {
    while (nextIdx < sessionIds.length) {
      const idx = nextIdx++;
      results[idx] = await database
        .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
        .from(sessionMessages)
        .where(eq(sessionMessages.sessionId, sessionIds[idx]))
        .orderBy(desc(sessionMessages.id))
        .limit(PER_SESSION_MESSAGE_LIMIT);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PER_SESSION_QUERY_CONCURRENCY, sessionIds.length) }, worker),
  );
  return results.flat();
}
