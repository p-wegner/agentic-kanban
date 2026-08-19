import { summarizeRepoInstalls } from "@agentic-kanban/shared/lib/repo-install-state";
import type {
  DiffStatsRepoEntry,
  DiffStatsResponse,
  WorkspaceHandoffRepoEntry,
  WorkspaceHandoffResponse,
  WorkspaceRepoStatusBatchResponse,
  WorkspaceRepoStatusEntry,
} from "@agentic-kanban/shared";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import * as realGitService from "./git.service.js";
import type { GitService } from "./workspace-internals.js";
import { computeRepoMergeEntry, type RepoMergeStatus } from "./repo-merge-status.service.js";
import { siblingRefFromRow, type WorkspaceRepoRef } from "./workspace-all-repos.js";
import { readHandoffMeta } from "./handoff.service.js";
import {
  listBatchRepoRows,
  listBatchWorkspaceRows,
} from "../repositories/workspace-repo-status-batch.repository.js";
import { getProjectRepoFields } from "../repositories/project.repository.js";

/**
 * #415 — GET /api/projects/:id/workspace-repo-status: the batched replacement for the
 * per-workspace {repo-merge-status, conflicts, handoff, diff} client fan-out that cost
 * N workspaces × M repos × several git spawns per board-event burst (~300 spawns at
 * N=20, M=3). ONE request now covers every non-closed, non-direct workspace:
 *
 * - DB access is BATCHED (one workspaces-join query + one repos IN-query + one project
 *   read), not N × (getWorkspaceById + resolveProjectRepo + listWorkspaceRepos).
 * - Git work is bounded to {@link BATCH_GIT_CONCURRENCY} parallel per-workspace tasks.
 *   The #398 spawn scheduler still bounds actual subprocesses beneath this; the local
 *   bound keeps the batch from flooding its queue in one tick.
 * - The serialized body is memoized for {@link BATCH_MEMO_TTL_MS} per (project,
 *   include-set), so the differently-debounced panels of one WS burst — and repeated
 *   polls — cost one computation. The route wraps the body in conditionalJsonResponse,
 *   so an unchanged body is a 304 with no payload.
 *
 * Facets (via `?include=`): `merge` (per-repo merge status), `conflicts` (live
 * merge-tree probe — deliberately NOT projected, see decision 014's boundary; only paid
 * for workspaces whose merge status shows unlanded work), `handoff` (HANDOFF.md
 * metadata, fs-only), `diffstats` (per-repo shortstat; leading repo served from a fresh
 * diff_stat_cache row spawn-free).
 */

export const BATCH_MEMO_TTL_MS = 10_000;
export const BATCH_GIT_CONCURRENCY = 5;
/** Freshness window for serving the leading repo's diffstats from the persisted cache. */
const DIFF_STAT_CACHE_TTL_MS = 30_000;

export type RepoStatusFacet = "merge" | "conflicts" | "handoff" | "diffstats";
const ALL_FACETS: RepoStatusFacet[] = ["merge", "conflicts", "handoff", "diffstats"];

export function parseIncludeParam(raw: string | undefined): RepoStatusFacet[] {
  if (!raw) return ["merge", "conflicts", "handoff"];
  const parts = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const facets = ALL_FACETS.filter((f) => parts.includes(f));
  return facets.length > 0 ? facets : ["merge", "conflicts", "handoff"];
}

// ── short in-memory memo ─────────────────────────────────────────────────────
const memo = new Map<string, { body: string; at: number }>();
export function __resetWorkspaceRepoStatusMemoForTests(): void {
  memo.clear();
}

/** Bounded-parallel map: at most `limit` tasks in flight, order preserved. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface BatchDeps {
  database?: Database;
  gitService?: GitService;
}

/**
 * The memoized entry point the route calls: returns the SERIALIZED body so the memo and
 * the ETag both work over the exact bytes served.
 */
export async function serveWorkspaceRepoStatusBatch(
  projectId: string,
  include: RepoStatusFacet[],
  deps: BatchDeps = {},
): Promise<string> {
  const key = `${projectId}::${[...include].sort().join(",")}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < BATCH_MEMO_TTL_MS) return hit.body;
  const result = await buildWorkspaceRepoStatusBatch(projectId, include, deps);
  const body = JSON.stringify(result);
  if (memo.size > 200) memo.clear(); // crude cap — entries are per (project, include-set)
  memo.set(key, { body, at: Date.now() });
  return body;
}

/** Uncached batch computation (exported for the parity tests). */
export async function buildWorkspaceRepoStatusBatch(
  projectId: string,
  include: RepoStatusFacet[],
  deps: BatchDeps = {},
): Promise<WorkspaceRepoStatusBatchResponse> {
  const database = deps.database ?? db;
  const gitService = deps.gitService ?? (realGitService as GitService);

  const project = await getProjectRepoFields(projectId, database);
  if (!project) {
    return { projectId, include, workspaces: [] };
  }

  // One query over all non-closed, non-direct workspaces of the project…
  const wsRows = await listBatchWorkspaceRows(projectId, database);

  // …and one IN-query for every repos row (leading + siblings) those workspaces span.
  const repoRows = await listBatchRepoRows(wsRows.map((w) => w.id), database);
  const repoRowsByWs = new Map<string, typeof repoRows>();
  for (const row of repoRows) {
    const list = repoRowsByWs.get(row.workspaceId as string) ?? [];
    list.push(row);
    repoRowsByWs.set(row.workspaceId as string, list);
  }

  const entries = await mapBounded(wsRows, BATCH_GIT_CONCURRENCY, async (ws): Promise<WorkspaceRepoStatusEntry> => {
    const rows = repoRowsByWs.get(ws.id) ?? [];
    const leadingRow = rows.find((r) => r.isLeading) ?? null;
    const siblingRows = rows.filter((r) => !r.isLeading);
    // Same source precedence as leadingRef (#226): the physical row wins, the workspace
    // mirror columns are the fallback. No read-repair here — this is a bulk read path;
    // a pre-0110 workspace without a row heals on its next per-workspace read.
    const leadingRef: WorkspaceRepoRef = {
      kind: "leading",
      id: ws.id,
      workspaceId: ws.id,
      path: project.repoPath,
      name: null,
      worktreePath: leadingRow?.worktreePath ?? ws.workingDir ?? null,
      branch: leadingRow?.branch ?? ws.branch ?? null,
      baseBranch: leadingRow?.baseBranch || ws.baseBranch || project.defaultBranch,
      baseCommitSha: leadingRow?.baseCommitSha ?? ws.baseCommitSha ?? null,
      mergedHeadSha: leadingRow?.mergedHeadSha ?? ws.mergedHeadSha ?? null,
      defaultBranch: project.defaultBranch,
      projectionRowId: leadingRow?.id ?? null,
      summaryAhead: leadingRow?.summaryAhead ?? null,
      summaryHistoric: leadingRow?.summaryHistoric ?? null,
      summaryGitRefreshedAt: leadingRow?.summaryGitRefreshedAt ?? null,
      summaryDirty: leadingRow?.summaryDirty ?? null,
      installState: leadingRow?.installState ?? null,
      installDetail: leadingRow?.installDetail ?? null,
    };
    const refs: WorkspaceRepoRef[] = [leadingRef, ...siblingRows.map(siblingRefFromRow)];
    const baseBranch = leadingRef.baseBranch ?? "";

    const entry: WorkspaceRepoStatusEntry = {
      workspaceId: ws.id,
      issueId: ws.issueId,
      branch: ws.branch,
      status: ws.status,
      mergedAt: ws.mergedAt,
      mergeStatus: null,
      conflicts: null,
      handoff: null,
      diffStats: null,
    };

    if (include.includes("merge")) {
      try {
        const repoEntries = [];
        for (const ref of refs) {
          // #415 sibling projection: a fresh row answers spawn-free; a live compute
          // writes through so the NEXT burst is spawn-free.
          repoEntries.push(await computeRepoMergeEntry(ref, gitService, { workspaceStatus: ws.status, database }));
        }
        const mergeStatus: RepoMergeStatus = {
          branch: ws.branch,
          baseBranch,
          allMerged: repoEntries.every((r) => !r.hasWork || r.merged),
          repos: repoEntries,
          // #666 — the batch is a PARITY endpoint for the per-workspace one, and #628 added
          // `installSummary` to `repo-merge-status.service.ts` without adding it here. A
          // client reading the batch therefore saw no install progress at all, which is
          // exactly the state #628 exists to surface (installs deferred off the launch path).
          installSummary: summarizeRepoInstalls(refs.map((r) => r.installState)),
        };
        entry.mergeStatus = mergeStatus;
      } catch { /* per-workspace best-effort — entry.mergeStatus stays null */ }
    }

    if (include.includes("conflicts")) {
      // Only pay for the merge-tree probes when there is unlanded work (the same
      // heuristic the client fan-out used); without merge facts, probe unconditionally.
      const hasUnlanded = entry.mergeStatus
        ? entry.mergeStatus.repos.some((r) => r.hasWork && !r.merged)
        : true;
      if (!hasUnlanded) {
        entry.conflicts = { hasConflicts: false, conflictingFiles: [] };
      } else {
        try {
          let hasConflicts = false;
          const conflictingFiles: string[] = [];
          for (const ref of refs) {
            if (!ref.worktreePath || !ref.baseBranch) continue;
            const result = await gitService.detectConflicts(ref.worktreePath, ref.baseBranch).catch(() => null);
            if (result?.hasConflicts) {
              hasConflicts = true;
              conflictingFiles.push(...result.conflictingFiles);
            }
          }
          entry.conflicts = { hasConflicts, conflictingFiles };
        } catch { /* best-effort */ }
      }
    }

    if (include.includes("handoff")) {
      const absent = { exists: false, updatedAt: null, excerpt: null };
      const handoffRepos: WorkspaceHandoffRepoEntry[] = [];
      for (const ref of refs) {
        const meta = ref.worktreePath ? await readHandoffMeta(ref.worktreePath) : absent;
        handoffRepos.push({ name: ref.kind === "leading" ? null : ref.name, ...meta });
      }
      const leading = handoffRepos[0] ?? { name: null, ...absent };
      const handoff: WorkspaceHandoffResponse = {
        exists: leading.exists,
        updatedAt: leading.updatedAt,
        excerpt: leading.excerpt,
        repos: handoffRepos,
      };
      entry.handoff = handoff;
    }

    if (include.includes("diffstats")) {
      const zero = { filesChanged: 0, insertions: 0, deletions: 0 };
      const repoStats: DiffStatsRepoEntry[] = [];
      for (const ref of refs) {
        let stats = zero;
        if (ref.kind === "leading") {
          const cacheFresh =
            ws.diffStatCacheCheckedAt !== null &&
            Date.now() - new Date(ws.diffStatCacheCheckedAt).getTime() < DIFF_STAT_CACHE_TTL_MS;
          if (cacheFresh) {
            stats = {
              filesChanged: ws.diffStatCacheFilesChanged ?? 0,
              insertions: ws.diffStatCacheInsertions ?? 0,
              deletions: ws.diffStatCacheDeletions ?? 0,
            };
          } else if (ref.worktreePath && ref.baseBranch) {
            stats = await gitService.getDiffShortstat(ref.worktreePath, ref.baseBranch).catch(() => zero);
          }
        } else if (ref.worktreePath && ref.baseBranch) {
          stats = await gitService.getDiffShortstat(ref.worktreePath, ref.baseBranch).catch(() => zero);
        }
        repoStats.push({ name: ref.kind === "leading" ? null : ref.name, path: ref.path, stats });
      }
      const total = repoStats.reduce(
        (acc, r) => ({
          filesChanged: acc.filesChanged + r.stats.filesChanged,
          insertions: acc.insertions + r.stats.insertions,
          deletions: acc.deletions + r.stats.deletions,
        }),
        { ...zero },
      );
      const diffStats: DiffStatsResponse = { stats: total, repos: repoStats };
      entry.diffStats = diffStats;
    }

    return entry;
  });

  return { projectId, include, workspaces: entries };
}
