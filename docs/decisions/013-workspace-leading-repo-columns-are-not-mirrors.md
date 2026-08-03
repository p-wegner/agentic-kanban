# Decision 013: workspace `branch/workingDir/baseBranch/baseCommitSha/mergedHeadSha` are not mirror columns — dropping them is a staged epic, not a call-site sweep

## Date: 2026-08-03

## Context

#210 set out to audit `workspaces.{branch,workingDir,baseBranch,baseCommitSha,mergedHeadSha}`
before dropping them, on the assumption (from #176/#168's "physical leading-repo row" work)
that they now duplicate data already stored in the `repos` table.

They don't. `repos` (`packages/shared/src/schema/repos.ts`) only ever gets a row for
**sibling** repos in a multi-repo workspace. There is no stored `ordinal=0`/`isLeading=true`
row for the leading repo — `getAllWorkspaceRepos` (`packages/server/src/services/workspace-all-repos.ts`,
`leadingRef()`) *synthesizes* that pseudo-row at read time from those five workspace columns
plus `projects.repoPath/defaultBranch`.

For the common case (a single-repo project), these columns are therefore the **sole storage**
for the leading repo's identity, not a duplicate of anything in `repos`. #176/#168's "physical
leading-repo row" only materialized `repos.ordinal=0` as a *dual-write* alongside the workspace
columns for siblings — it never stopped the workspace columns from being the leading repo's
actual source of truth for reads.

`branch`/`workingDir`/`baseBranch` are also exposed directly on the client-facing
`WorkspaceResponse` DTO (`packages/shared/src/types/api/workspace.ts`) and rendered pervasively
in the UI (WorkspaceCard, WorkspaceActionBar, MergeQueuePanel, etc.), so a column drop is a
DTO/UI migration too, not just a server-internal sweep.

#210's actual code scope (rewriting `updateBase`'s leading+sibling loop to use
`getAllWorkspaceRepos` uniformly) was unaffected and already completed by commit `1946eeea92`
before this was discovered.

## Decision

Treat the column drop as its own staged epic (#222), not a follow-on task to sweep call sites:

1. **#223** — backfill migration: insert a real `repos` row (`isLeading=true`, `ordinal=0`) for
   every existing workspace from its current `branch/workingDir/baseBranch/baseCommitSha/mergedHeadSha`.
   Purely additive; does not touch `leadingRef()` or any call site yet.
2. **#224** — repoint `leadingRef()` to read that real row instead of synthesizing from
   `workspaces` columns, and route the write paths (starting with `mergedHeadSha`, already
   routed through `stampRepoMergedHeadSha` and closest to repo-model-native) to keep it in sync.
3. **#225** — migrate the `WorkspaceResponse` DTO and the UI components that read
   `workspace.branch`/`workingDir`/`baseBranch` directly to derive from the leading repo row.
4. **#226** — once nothing reads the five columns, drop them and the now-dead write paths.

Each stage depends on the previous one merging first.

## Consequences

**Good**
- The migration path is safe at every stage: each ticket lands independently, and the columns
  stay dual-written (never a single point of truth mid-epic) until stage 4 actually drops them.
- `leadingRef()` moves from synthesizing a read-time pseudo-row to a real, queryable row, which
  also removes the leading/sibling asymmetry in `repos`.

**Costs / risks accepted**
- Four sequential tickets instead of one; slower than the originally assumed "just sweep call
  sites and drop the columns."
- Stage 3 touches UI call sites pervasively (WorkspaceCard, WorkspaceActionBar,
  MergeQueuePanel, ...), which is the largest-blast-radius stage.

## Alternatives rejected

- **Drop the columns directly after a call-site grep (#210's original framing).** Would silently
  destroy the leading repo's only stored identity for every single-repo project, since
  `leadingRef()` has nothing else to synthesize from.
- **Backfill and repoint in one ticket.** Keeping the backfill purely additive (stage 1) means a
  bad backfill migration is inspectable and re-runnable before anything starts reading from it.

## Implementation

Epic tracked via #222 (this finding) → #223 → #224 → #225 → #226, each `depends_on` the previous.
