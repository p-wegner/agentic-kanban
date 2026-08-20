/**
 * Per-repo dependency-install state (#628) — the vocabulary for `repos.install_state`.
 *
 * Lives in `lib/` rather than beside the table because the CLIENT renders it ("installing
 * 3/16"), and anything declared beside a `sqliteTable` drags drizzle into the browser
 * bundle (see packages/shared/CLAUDE.md, "Where a column's VOCABULARY lives").
 *
 * Only the `background` install mode writes these. Under `sequential`/`parallel` the
 * install has already finished before the row exists, so the column stays NULL and every
 * predicate here treats NULL as "nothing outstanding" — that is what keeps single-repo and
 * inline-install projects on exactly their old behaviour.
 */
export const REPO_INSTALL_STATES = ["pending", "running", "done", "failed", "skipped"] as const;

export type RepoInstallState = (typeof REPO_INSTALL_STATES)[number];

export function isRepoInstallState(value: unknown): value is RepoInstallState {
  return typeof value === "string" && (REPO_INSTALL_STATES as readonly string[]).includes(value);
}

/** Still working: the deps for this repo are not on disk yet. */
export function isRepoInstallOutstanding(state: string | null | undefined): boolean {
  return state === "pending" || state === "running";
}

/**
 * Would landing this branch be unsafe? `failed` counts, and that is the whole point of the
 * column: with installs deferred off the launch path, the merge gate is what has to refuse
 * a branch whose dependencies never came up — the protection `setupFailedBlocking` (#169)
 * used to give by refusing the LAUNCH.
 */
export function blocksMerge(state: string | null | undefined): boolean {
  return isRepoInstallOutstanding(state) || state === "failed";
}

export interface RepoInstallSummary {
  /** Repos whose install is tracked at all (i.e. non-NULL state). */
  tracked: number;
  done: number;
  failed: number;
  outstanding: number;
  /** True while any repo is pending/running — what an "installing 3/16" chip renders on. */
  installing: boolean;
}

export function summarizeRepoInstalls(states: Array<string | null | undefined>): RepoInstallSummary {
  const tracked = states.filter((s) => s != null && s !== "").length;
  const done = states.filter((s) => s === "done" || s === "skipped").length;
  const failed = states.filter((s) => s === "failed").length;
  const outstanding = states.filter(isRepoInstallOutstanding).length;
  return { tracked, done, failed, outstanding, installing: outstanding > 0 };
}
