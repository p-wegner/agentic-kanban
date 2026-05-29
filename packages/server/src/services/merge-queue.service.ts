import type { Database } from "../db/index.js";
import { workspaces, issues, projects } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import * as gitService from "./git.service.js";
import { createWorkspaceMergeService } from "./workspace-merge.service.js";
import type { BoardEvents } from "./board-events.js";
import type { SessionManager } from "./session.manager.js";

export interface WorkspaceQueueInfo {
  id: string;
  branch: string;
  workingDir: string | null;
  baseBranch: string;
  repoPath: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  changedFiles: string[];
  status: string;
}

export interface OverlapEntry {
  workspaceIdA: string;
  workspaceIdB: string;
  overlapCount: number;
  files: string[];
}

export interface MergeQueuePlan {
  order: WorkspaceQueueInfo[];
  overlaps: OverlapEntry[];
  totalOverlapScore: number;
}

export type MergeQueueEvent =
  | { type: "planned"; plan: MergeQueuePlan }
  | { type: "rebasing"; workspaceId: string; issueNumber: number | null; issueTitle: string; position: number; total: number }
  | { type: "rebase_ok"; workspaceId: string; issueNumber: number | null; issueTitle: string }
  | { type: "merging"; workspaceId: string; issueNumber: number | null; issueTitle: string; position: number; total: number }
  | { type: "merged"; workspaceId: string; issueNumber: number | null; issueTitle: string }
  | { type: "conflict"; workspaceId: string; issueNumber: number | null; issueTitle: string; conflictingFiles: string[]; error: string }
  | { type: "error"; workspaceId: string; issueNumber: number | null; issueTitle: string; error: string }
  | { type: "skipped"; workspaceId: string; issueNumber: number | null; issueTitle: string; reason: string }
  | { type: "done"; merged: string[]; failed: string[]; skipped: string[] };

export function createMergeQueueService(deps: {
  database: Database;
  boardEvents?: BoardEvents;
  getSessionManager?: () => SessionManager;
}) {
  const { database, boardEvents, getSessionManager } = deps;
  const mergeService = createWorkspaceMergeService({
    database,
    boardEvents,
    getSessionManager,
  });

  async function getWorkspaceQueueInfos(workspaceIds: string[]): Promise<WorkspaceQueueInfo[]> {
    if (workspaceIds.length === 0) return [];

    const wsRows = await database
      .select()
      .from(workspaces)
      .where(inArray(workspaces.id, workspaceIds));

    const issueIds = wsRows.map((w) => w.issueId);
    const issueRows = await database
      .select()
      .from(issues)
      .where(inArray(issues.id, issueIds));

    const projectIds = [...new Set(issueRows.map((i) => i.projectId))];
    const projectRows = await database
      .select()
      .from(projects)
      .where(inArray(projects.id, projectIds));

    const issueMap = new Map(issueRows.map((i) => [i.id, i]));
    const projectMap = new Map(projectRows.map((p) => [p.id, p]));

    const result: WorkspaceQueueInfo[] = [];
    for (const ws of wsRows) {
      const issue = issueMap.get(ws.issueId);
      if (!issue) continue;
      const project = projectMap.get(issue.projectId);
      if (!project) continue;

      const baseBranch = ws.baseBranch || project.defaultBranch || "main";

      let changedFiles: string[] = [];
      try {
        if (ws.workingDir) {
          changedFiles = await gitService.getChangedFileNames(ws.workingDir, baseBranch);
        } else if (ws.branch) {
          changedFiles = await gitService.getChangedFilesBetween(project.repoPath, baseBranch, ws.branch);
        }
      } catch {
        // best effort
      }

      result.push({
        id: ws.id,
        branch: ws.branch,
        workingDir: ws.workingDir,
        baseBranch,
        repoPath: project.repoPath,
        issueId: ws.issueId,
        issueNumber: issue.issueNumber ?? null,
        issueTitle: issue.title,
        changedFiles,
        status: ws.status,
      });
    }

    // Preserve the caller's requested order for any IDs not found
    return workspaceIds.flatMap((id) => result.find((r) => r.id === id) ?? []);
  }

  function computeOverlaps(infos: WorkspaceQueueInfo[]): OverlapEntry[] {
    const overlaps: OverlapEntry[] = [];
    for (let i = 0; i < infos.length; i++) {
      for (let j = i + 1; j < infos.length; j++) {
        const a = infos[i];
        const b = infos[j];
        const setB = new Set(b.changedFiles);
        const commonFiles = a.changedFiles.filter((f) => setB.has(f));
        overlaps.push({
          workspaceIdA: a.id,
          workspaceIdB: b.id,
          overlapCount: commonFiles.length,
          files: commonFiles,
        });
      }
    }
    return overlaps;
  }

  /** Greedy sort: repeatedly pick the workspace with the least overlap against the remaining set. */
  function sortByLeastOverlap(infos: WorkspaceQueueInfo[], overlaps: OverlapEntry[]): WorkspaceQueueInfo[] {
    if (infos.length <= 1) return [...infos];

    const remaining = new Set(infos.map((i) => i.id));
    const sorted: WorkspaceQueueInfo[] = [];
    const infoMap = new Map(infos.map((i) => [i.id, i]));

    while (remaining.size > 0) {
      let bestId: string | null = null;
      let bestScore = Infinity;

      for (const id of remaining) {
        let score = 0;
        for (const other of remaining) {
          if (other === id) continue;
          const entry = overlaps.find(
            (e) =>
              (e.workspaceIdA === id && e.workspaceIdB === other) ||
              (e.workspaceIdB === id && e.workspaceIdA === other),
          );
          score += entry?.overlapCount ?? 0;
        }
        if (score < bestScore) {
          bestScore = score;
          bestId = id;
        }
      }

      if (bestId) {
        remaining.delete(bestId);
        const info = infoMap.get(bestId);
        if (info) sorted.push(info);
      } else {
        break;
      }
    }

    return sorted;
  }

  async function computePlan(workspaceIds: string[]): Promise<MergeQueuePlan> {
    const infos = await getWorkspaceQueueInfos(workspaceIds);
    const overlaps = computeOverlaps(infos);
    const sortedInfos = sortByLeastOverlap(infos, overlaps);
    const totalOverlapScore = overlaps.reduce((s, e) => s + e.overlapCount, 0);
    return { order: sortedInfos, overlaps, totalOverlapScore };
  }

  async function* executeQueue(
    workspaceIds: string[],
    opts: { skipOnConflict?: boolean } = {},
  ): AsyncGenerator<MergeQueueEvent> {
    const plan = await computePlan(workspaceIds);
    yield { type: "planned", plan };

    const merged: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const total = plan.order.length;

    for (let i = 0; i < plan.order.length; i++) {
      const ws = plan.order[i];
      const position = i + 1;

      // Skip already-closed workspaces
      try {
        const [current] = await database
          .select({ status: workspaces.status })
          .from(workspaces)
          .where(eq(workspaces.id, ws.id))
          .limit(1);
        if (current?.status === "closed") {
          skipped.push(ws.id);
          yield {
            type: "skipped",
            workspaceId: ws.id,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
            reason: "workspace already closed",
          };
          continue;
        }
      } catch {
        // best-effort check
      }

      // Rebase onto base first (if we have a working dir)
      if (ws.workingDir && !ws.status.startsWith("direct")) {
        yield {
          type: "rebasing",
          workspaceId: ws.id,
          issueNumber: ws.issueNumber,
          issueTitle: ws.issueTitle,
          position,
          total,
        };
        try {
          const rebaseResult = await gitService.rebaseOntoBase(ws.workingDir, ws.baseBranch, ws.branch);
          if (!rebaseResult.success) {
            if (opts.skipOnConflict) {
              skipped.push(ws.id);
              yield {
                type: "skipped",
                workspaceId: ws.id,
                issueNumber: ws.issueNumber,
                issueTitle: ws.issueTitle,
                reason: `rebase conflict: ${rebaseResult.conflictingFiles?.join(", ") ?? rebaseResult.error ?? "unknown"}`,
              };
              continue;
            }
            failed.push(ws.id);
            yield {
              type: "conflict",
              workspaceId: ws.id,
              issueNumber: ws.issueNumber,
              issueTitle: ws.issueTitle,
              conflictingFiles: rebaseResult.conflictingFiles ?? [],
              error: rebaseResult.error ?? "Rebase failed",
            };
            break; // Stop queue — resumable after manual fix
          }
          yield {
            type: "rebase_ok",
            workspaceId: ws.id,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
          };
        } catch (err) {
          failed.push(ws.id);
          yield {
            type: "error",
            workspaceId: ws.id,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
            error: err instanceof Error ? err.message : String(err),
          };
          break;
        }
      }

      // Merge
      yield {
        type: "merging",
        workspaceId: ws.id,
        issueNumber: ws.issueNumber,
        issueTitle: ws.issueTitle,
        position,
        total,
      };
      try {
        await mergeService.mergeWorkspace(ws.id);
        merged.push(ws.id);
        yield {
          type: "merged",
          workspaceId: ws.id,
          issueNumber: ws.issueNumber,
          issueTitle: ws.issueTitle,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const isConflict = error.toLowerCase().includes("conflict") || (err instanceof Error && (err as unknown as { code?: string }).code === "CONFLICT");

        if (isConflict) {
          if (opts.skipOnConflict) {
            skipped.push(ws.id);
            yield {
              type: "skipped",
              workspaceId: ws.id,
              issueNumber: ws.issueNumber,
              issueTitle: ws.issueTitle,
              reason: `merge conflict: ${error}`,
            };
            continue;
          }
          failed.push(ws.id);
          yield {
            type: "conflict",
            workspaceId: ws.id,
            issueNumber: ws.issueNumber,
            issueTitle: ws.issueTitle,
            conflictingFiles: [],
            error,
          };
          break;
        }

        failed.push(ws.id);
        yield {
          type: "error",
          workspaceId: ws.id,
          issueNumber: ws.issueNumber,
          issueTitle: ws.issueTitle,
          error,
        };
        break;
      }
    }

    yield { type: "done", merged, failed, skipped };
  }

  return { computePlan, executeQueue };
}
