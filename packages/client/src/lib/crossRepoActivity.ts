// Pure reducer for the cross-repo activity feed (#88).
//
// The feed is a chronological, repo-labeled narrative of what is landing across a
// multi-repo project. It is driven by DELTAS: the hook snapshots each workspace's
// GET /api/workspaces/:id/repo-merge-status and /conflicts, and on relevant
// board-events WS reasons re-fetches and diffs the new snapshot against the stored
// one. Each transition (a repo merged, went stranded, gained commits, a conflict
// appeared or cleared) becomes one repo-labeled feed entry. This module is the pure,
// React-free core so it is unit-testable without a DOM or a running server.

import type { RepoMergeStatusResponse, RepoMergeStatusRepoEntry } from "@agentic-kanban/shared";
import { groupConflictsByRepo, LEADING_REPO_LABEL } from "./groupConflictsByRepo.js";

export type CrossRepoActivityKind =
  | "repo_merged"
  | "repo_stranded"
  | "repo_ahead"
  | "conflict_appeared"
  | "conflict_cleared"
  | "handoff_updated";

export interface CrossRepoActivityEntry {
  /** Stable dedupe key: `${workspaceId}:${repo}:${kind}`. Repeated identical deltas collapse. */
  id: string;
  timestamp: string;
  /** Repo label — a sibling repo name, or {@link LEADING_REPO_LABEL} for the leading repo. */
  repo: string;
  kind: CrossRepoActivityKind;
  summary: string;
  workspaceId: string;
  issueId: string | null;
  issueNumber: number | null;
}

/** Per-workspace context threaded into each emitted entry (for links + labeling). */
export interface CrossRepoActivityContext {
  workspaceId: string;
  issueId: string | null;
  issueNumber: number | null;
  /** ISO timestamp stamped onto entries — injected so the reducer stays pure/testable. */
  timestamp: string;
  /** Base branch label for merge summaries (falls back to "base"). */
  baseBranch?: string | null;
}

/** The merge state of a single repo, collapsed to the transitions the feed cares about. */
type RepoState = "none" | "merged" | "stranded" | "ahead";

function repoState(repo: RepoMergeStatusRepoEntry): RepoState {
  if (!repo.hasWork) return "none";
  if (repo.merged) return "merged";
  if (repo.stranded) return "stranded";
  return "ahead";
}

function repoLabel(repo: RepoMergeStatusRepoEntry): string {
  return repo.name ?? LEADING_REPO_LABEL;
}

function issuePrefix(ctx: CrossRepoActivityContext): string {
  return ctx.issueNumber != null ? `#${ctx.issueNumber} ` : "";
}

/**
 * Diff a repo-merge-status snapshot against the previous one, emitting one entry per
 * repo whose state changed. `prev = null` (first observation) is treated as a baseline
 * — no entries — so opening the feed doesn't replay every already-landed repo as "new".
 */
export function reduceRepoMergeStatusDelta(
  prev: RepoMergeStatusResponse | null,
  next: RepoMergeStatusResponse,
  ctx: CrossRepoActivityContext,
): CrossRepoActivityEntry[] {
  if (!prev) return [];
  const prevByPath = new Map(prev.repos.map((r) => [r.path, r]));
  const base = ctx.baseBranch ?? next.baseBranch ?? "base";
  const out: CrossRepoActivityEntry[] = [];

  for (const repo of next.repos) {
    const before = prevByPath.get(repo.path);
    if (!before) continue; // repo appeared in the set — no prior state to transition from
    const from = repoState(before);
    const to = repoState(repo);
    if (from === to) continue;

    const label = repoLabel(repo);
    if (to === "merged") {
      out.push(entry(ctx, label, "repo_merged", `${issuePrefix(ctx)}${label} merged into ${base}`));
    } else if (to === "stranded") {
      out.push(entry(ctx, label, "repo_stranded", `${issuePrefix(ctx)}${label} stranded — ${repo.ahead} ahead, not on ${base}`));
    } else if (to === "ahead") {
      // none/merged → ahead means new unlanded commits appeared on this repo's branch.
      out.push(entry(ctx, label, "repo_ahead", `${issuePrefix(ctx)}${label} advanced — ${repo.ahead} ahead of ${base}`));
    }
    // Transitions back to "none" (work reverted/removed) are not surfaced.
  }
  return out;
}

/**
 * Diff two `conflictingFiles` snapshots (the namespaced `repo::file` form from #76).
 * A repo that gains conflicting files emits "conflict appeared"; a repo that had
 * conflicts and now has none emits "conflict cleared". Because the two kinds carry
 * distinct ids, a conflict that appears and later clears yields two separate entries.
 */
export function reduceConflictsDelta(
  prevFiles: readonly string[] | null,
  nextFiles: readonly string[],
  ctx: CrossRepoActivityContext,
): CrossRepoActivityEntry[] {
  // A null prev is a first observation (baseline) — pre-existing conflicts are not
  // "new", so we don't replay them; only transitions from a known prior state emit.
  if (prevFiles === null) return [];
  const prevRepos = new Set(groupConflictsByRepo(prevFiles).groups.map((g) => g.repo));
  const nextRepos = new Set(groupConflictsByRepo(nextFiles).groups.map((g) => g.repo));
  const out: CrossRepoActivityEntry[] = [];

  for (const repo of nextRepos) {
    if (!prevRepos.has(repo)) {
      out.push(entry(ctx, repo, "conflict_appeared", `${issuePrefix(ctx)}${repo} conflicts with base`));
    }
  }
  for (const repo of prevRepos) {
    if (!nextRepos.has(repo)) {
      out.push(entry(ctx, repo, "conflict_cleared", `${issuePrefix(ctx)}${repo} conflict cleared`));
    }
  }
  return out;
}

/** Minimal HANDOFF.md metadata the handoff reducer diffs (subset of WorkspaceHandoffRepoEntry). */
export interface HandoffRepoState {
  exists: boolean;
  updatedAt: string | null;
}

/**
 * Diff a repo's HANDOFF.md mtime against the last-observed one, emitting a single
 * `handoff_updated` entry when a handoff first appears or its mtime advances.
 *
 * `prevUpdatedAt` distinguishes three states:
 *  - `undefined` — this repo's handoff was never observed (first snapshot). Treated as a
 *    baseline so opening the feed doesn't replay a pre-existing HANDOFF.md as "new".
 *  - `null` — observed before, but no handoff existed then. A handoff appearing now emits.
 *  - a string — the last-seen ISO mtime. Only a strictly newer mtime emits.
 *
 * The emitted id embeds the mtime (`…:handoff_updated:<mtime>`) so repeated polls at the
 * same mtime dedupe in {@link appendActivityEntries}, while each real update is distinct.
 */
export function reduceHandoffDelta(
  prevUpdatedAt: string | null | undefined,
  next: HandoffRepoState,
  repo: string,
  ctx: CrossRepoActivityContext,
): CrossRepoActivityEntry[] {
  if (prevUpdatedAt === undefined) return []; // never observed → baseline, no replay
  if (!next.exists || !next.updatedAt) return []; // no handoff to report
  // Emit on first appearance (prev null) or a strictly newer mtime.
  if (prevUpdatedAt !== null && !(next.updatedAt > prevUpdatedAt)) return [];
  return [{
    id: `${ctx.workspaceId}:${repo}:handoff_updated:${next.updatedAt}`,
    timestamp: ctx.timestamp,
    repo,
    kind: "handoff_updated",
    summary: `${issuePrefix(ctx)}${repo} handoff updated`,
    workspaceId: ctx.workspaceId,
    issueId: ctx.issueId,
    issueNumber: ctx.issueNumber,
  }];
}

function entry(
  ctx: CrossRepoActivityContext,
  repo: string,
  kind: CrossRepoActivityKind,
  summary: string,
): CrossRepoActivityEntry {
  return {
    id: `${ctx.workspaceId}:${repo}:${kind}`,
    timestamp: ctx.timestamp,
    repo,
    kind,
    summary,
    workspaceId: ctx.workspaceId,
    issueId: ctx.issueId,
    issueNumber: ctx.issueNumber,
  };
}

/**
 * Merge freshly-computed entries into the existing (newest-first) feed: drop any whose
 * id is already present (dedupe of repeated events), prepend the rest, sort newest-first
 * by timestamp, and cap to a recent window. Stable within equal timestamps: newly added
 * entries keep insertion order relative to each other.
 */
export function appendActivityEntries(
  existing: readonly CrossRepoActivityEntry[],
  incoming: readonly CrossRepoActivityEntry[],
  cap = 100,
): CrossRepoActivityEntry[] {
  const seen = new Set(existing.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return existing.slice(0, cap) as CrossRepoActivityEntry[];
  const merged = [...fresh, ...existing];
  // Stable sort newest-first; equal timestamps keep the order above (fresh before old).
  merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return merged.slice(0, cap);
}
