/**
 * The ONE place a workspace's base branch is resolved (#1239, decision 019 part 2).
 *
 * Every merge, review, rebase, diff and containment path used to spell the same fallback by
 * hand — `requireBaseBranch(workspace.baseBranch || defaultBranch)` — which was correct, but
 * invisible: a reader could not tell whether a path honoured the workspace's OWN base or
 * silently assumed the project default. A heal ticket's workspace is based on a release
 * candidate (`workspaces.base_branch = rc/<date>`), so "base = project default branch" is now a
 * wrong assumption on a real path, not a theoretical one. Route every read through here; the
 * spelling that remains by hand is pinned, shrink-only, by
 * `workspace-base-read-ratchet.test.ts`.
 *
 * Precedence: the workspace row's `baseBranch`, else the project's `defaultBranch`, else a
 * `BAD_REQUEST` naming the missing configuration (the same error `requireBaseBranch` raised).
 */
import { parseHealTicketExternalKey } from "../lib/heal-ticket-key.js";
import { requireBaseBranch } from "./workspace-internals.js";

export interface WorkspaceBaseSource {
  baseBranch: string | null | undefined;
}

export interface ProjectBaseSource {
  defaultBranch: string | null | undefined;
}

/** The branch a workspace's diff/review/rebase/merge is measured against and lands on. */
export function resolveWorkspaceBase(workspace: WorkspaceBaseSource, project: ProjectBaseSource): string {
  return requireBaseBranch(workspace.baseBranch || project.defaultBranch);
}

/** Same resolution, `null` instead of throwing — for read paths that can say "unknown". */
export function resolveWorkspaceBaseOrNull(workspace: WorkspaceBaseSource, project: ProjectBaseSource): string | null {
  return workspace.baseBranch || project.defaultBranch || null;
}

/**
 * The base a NEW workspace for `issue` should branch from when the caller named none: an rc
 * heal ticket (`base-health-heal:<project>:<sig>:<rc>`) is healed ON its candidate, so its
 * workspace branches from the rc, rebases onto it and merges into it. Every other ticket
 * answers `null` — the project default applies, exactly as before #1239.
 */
export function resolveIssueBaseBranch(issueExternalKey: string | null | undefined): string | null {
  return parseHealTicketExternalKey(issueExternalKey)?.branch ?? null;
}
