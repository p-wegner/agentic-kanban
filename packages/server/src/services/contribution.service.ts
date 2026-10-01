import type { ContributionActorRow, ContributionGroupBy, ContributionsResponse } from "@agentic-kanban/shared";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "../repositories/project.repository.js";
import {
  getMergedWorkspaces,
  getSessionTotalsByActor,
  getWorkspaceCountsByActor,
  type ContributionWindow,
  type WorkspaceGroupBy,
} from "../repositories/contribution.repository.js";
import { resolveWorkspaceBaseOrNull } from "./workspace-base.js";
import * as realGitService from "./git.service.js";
import type { GitService } from "./workspace-internals.js";

export const UNSET_ACTOR_LABEL: Record<ContributionGroupBy, string> = {
  provider: "(unset)",
  profile: "(default profile)",
  model: "(default model)",
  author: "(unknown author)",
};

type CommitStats = Awaited<ReturnType<GitService["getCommitStatsForRange"]>>;

function emptyRow(actor: string, unset: boolean): ContributionActorRow {
  return {
    actor, unset,
    doneIssues: 0, mergedIssues: 0, workspaces: 0,
    sessions: 0, failedSessions: 0, abortedSessions: 0,
    mergedCommits: null, linesAdded: null, linesRemoved: null,
    inputTokens: null, outputTokens: null, costUsd: null, activeMs: null,
  };
}

function addNullable(current: number | null, delta: number): number {
  return (current ?? 0) + delta;
}

/**
 * Per-actor contribution totals for a project (#1264).
 *
 * Counts, tokens, cost and duration are aggregated in SQL (`contribution.repository.ts`).
 * Commits and line counts come from git history, but only for the project's merged
 * workspaces inside the window, one `git log` per workspace — merged ranges are immutable,
 * so each result is memoized. A metric with no recorded data stays `null` (the UI shows "–").
 * Multi-repo siblings are not counted: only the leading repo's history is read.
 */
export function createContributionService(deps: { database?: Database; gitService?: GitService } = {}) {
  const database = deps.database ?? db;
  const gitService = deps.gitService ?? realGitService;
  const rangeMemo = new Map<string, Promise<CommitStats>>();

  function commitStats(repoPath: string, baseRef: string, tip: string): Promise<CommitStats> {
    const memoKey = `${repoPath}\0${baseRef}\0${tip}`;
    let hit = rangeMemo.get(memoKey);
    if (!hit) {
      hit = gitService.getCommitStatsForRange(repoPath, baseRef, tip);
      rangeMemo.set(memoKey, hit);
    }
    return hit;
  }

  async function getContributions(
    projectId: string,
    groupBy: ContributionGroupBy,
    window: ContributionWindow,
  ): Promise<ContributionsResponse | null> {
    const project = await getProjectById(projectId, database);
    if (!project) return null;

    const rows = new Map<string, ContributionActorRow>();
    const rowFor = (actor: string): ContributionActorRow => {
      let row = rows.get(actor);
      if (!row) {
        const unset = actor === "";
        row = emptyRow(unset ? UNSET_ACTOR_LABEL[groupBy] : actor, unset);
        rows.set(actor, row);
      }
      return row;
    };

    const workspaceGroup: WorkspaceGroupBy = groupBy === "author" ? "provider" : groupBy;

    // Git-derived metrics need the merged workspaces' ranges; read them in every grouping.
    const merged = await getMergedWorkspaces(projectId, workspaceGroup, window, database);

    if (groupBy !== "author") {
      for (const w of await getWorkspaceCountsByActor(projectId, workspaceGroup, window, database)) {
        Object.assign(rowFor(w.actor), {
          workspaces: w.workspaces, mergedIssues: w.mergedIssues, doneIssues: w.doneIssues,
        });
      }
      for (const s of await getSessionTotalsByActor(projectId, workspaceGroup, window, database)) {
        Object.assign(rowFor(s.actor), {
          sessions: s.sessions, failedSessions: s.failedSessions, abortedSessions: s.abortedSessions,
          inputTokens: s.inputTokens, outputTokens: s.outputTokens, costUsd: s.costUsd, activeMs: s.activeMs,
        });
      }
    }

    const seenCommits = new Set<string>();
    for (const ws of merged) {
      const baseRef = ws.baseCommitSha || resolveWorkspaceBaseOrNull(ws, project);
      const tip = ws.mergedHeadSha || ws.branch;
      if (!baseRef || !tip) continue;
      for (const commit of await commitStats(project.repoPath, baseRef, tip)) {
        if (seenCommits.has(commit.sha)) continue;
        seenCommits.add(commit.sha);
        const row = groupBy === "author" ? rowFor(commit.author) : rowFor(ws.actor);
        row.mergedCommits = addNullable(row.mergedCommits, 1);
        row.linesAdded = addNullable(row.linesAdded, commit.added);
        row.linesRemoved = addNullable(row.linesRemoved, commit.removed);
      }
    }

    return {
      projectId,
      groupBy,
      from: window.from ?? null,
      to: window.to ?? null,
      // The SQL group-by spans the whole project, so an actor with nothing in the window
      // still comes back as an all-zero row; drop it.
      actors: [...rows.values()]
        .filter((r) => r.workspaces + r.sessions + r.mergedIssues + r.doneIssues > 0 || r.mergedCommits !== null)
        .sort((a, b) => a.actor.localeCompare(b.actor)),
    };
  }

  return { getContributions };
}
