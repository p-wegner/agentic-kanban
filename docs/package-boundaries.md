# Package boundaries: what the co-change numbers do and do not say

Answers the recurring question "one unit of work costs three packages — is the
`client`/`server`/`shared`/`mcp-server` split wrong?" It was asked as #730, with a measurement
attached and a recommendation to split `shared` by consumer. The measurement reproduces. The
recommendation does not follow from it, and this page is here so the next session does not have
to re-derive that from scratch — or act on the headline percentage without the attribution
underneath it.

Reproduce everything below with:

```
node scripts/measure-package-coupling.mjs            # full history
node scripts/measure-package-coupling.mjs --since=2026-06-01
```

The figures are behavioural: they move as history grows, so re-run rather than trusting a
number quoted in a ticket (including the ones on this page).

## The headline reproduces

Measured over 6,970 non-merge commits at `77ad12b138`, against #730's own claims:

| Claim | #730 | Re-derived | Verdict |
|---|---|---|---|
| commits touching 2+ packages | 29.3% | 27.4% (26.2% production-only) | reproduces |
| commits touching 3+ packages | 9.1% | 7.4% | reproduces |
| mean packages per change | 1.4 | 1.37 | reproduces |
| `shared` containment | 14% | 17% | reproduces |
| `mcp-server` / `server` / `client` containment | 64 / 57 / 55% | 64 / 56 / 50% | reproduces |
| top pair `server <-> shared` | 17% | 13.1% | reproduces (rank 2, not rank 1) |
| top pair `client <-> server` | 16% | 16.3% | reproduces (rank 1) |

The small deltas are the changeset definition — #730 grouped commits into 3,125 PR-shaped
changesets, this script counts commits — plus 3,200 commits of history since. Nothing in the
measurement is wrong.

## What the headline hides: the attribution

A percentage of crossing commits says nothing about whether a boundary is at fault until you
ask *which* boundary each crossing crossed. Of the 1,336 crossings that are genuine production
code (test files, generated bookkeeping, manifests, config, docs and the test-only packages
excluded):

| Share | What is involved | Is the boundary at fault? |
|---|---|---|
| **49.7%** | **no `shared` file at all** — `client <-> server` | **No.** Two processes over HTTP. No rearrangement of packages collapses this. |
| ~21% | `shared/schema` and/or `shared/types` | **No.** The Drizzle tables and the hand-authored wire DTOs. One declaration, several consumers, deliberately. |
| **25.9%** | **`shared/lib`** | **Only here can it be.** A module can genuinely sit in the wrong package. |

Two consequences worth stating plainly:

- **`shared`'s low containment is not evidence of anything.** `shared` holds the DB schema and
  the wire contract. A package whose job is to be the single declaration that several packages
  consume *cannot* have high containment; measuring it and calling the result a defect is
  measuring the design and calling it a bug. `mcp-server`'s 64% is not "better modularity",
  it is a package with no such job.
- **The `client <-> server` half is a real problem, but a different one.** It is not the
  coupling that hurts, it is that nothing *enforces* the contract the two ends share:
  `types/api.ts` is `export type *` (erased at runtime), the client casts `res.json() as
  Promise<T>`, there is no `zValidator` in any route, and `openapi.yaml` has not been
  regenerated since the commit that created it. That is **#780**, and splitting `shared`
  would not touch it.

## The verdict on #730

**Do not split `shared` by consumer, and do not go vertical.** The upper bound on the benefit
is measurable, and it is small: relocating **every** single-consumer module out of `shared/lib`
would collapse **36 of 1,587** multi-package commits — 2.3%, taking 27.4% to 26.8%. A 31-file
move through the package every other package imports, for 0.6 percentage points, is churn.

#730's three-step proposal, judged separately:

1. **"Look at the misplaced files"** — worth doing, and done: the list is real (see below).
2. **"Split `shared` by consumer"** — rejected. The audiences #730 wants separated
   (`types` for client+server, `schema` for server+mcp-server, pure utilities) are already
   separate *directories* with an enforced boundary: `packages/client` has 0 imports of
   `shared/schema`, and `barrel-client-safety.test.ts` (#791/#875/#596) mechanically stops
   node-only and Drizzle-bearing code reaching the client bundle. Promoting those directories
   to packages buys a `package.json` each and the 0.6 points above.
3. **"Consider a vertical feature slice"** — rejected on the same measurement. Half the
   crossings are a process boundary that a folder layout cannot remove.

## What was actually wrong, and what now guards it

The one real finding is narrower than the ticket and has nothing to do with the horizontal
split: **`shared/lib` is documented (#590) as being for code more than one package needs, and
nothing checked it.** Measured at #730, **31 of 108** modules directly under
`packages/shared/src/lib/` have exactly one consuming package — 28 of them `server` alone —
and are not used by `shared`'s own code either.

Those 31 are grandfathered in `packages/shared/__tests__/shared-lib-single-consumer-ratchet.test.ts`
as a **shrink-only** set. The retroactive moves are deliberately *not* done (2.3%, above), but a
**new** single-consumer module in `shared/lib` now fails that suite — which is the case where the
fix is free, because the module is new and its consumer is known. Moving one out and deleting its
line is the sanctioned way to shrink the list.

Resolution notes that matter if you touch that guard: consumers import through the
`@agentic-kanban/shared/lib` barrel, not by path, so the guard attributes barrel imports to
whichever module exports each binding. A path-only scan reports almost nothing (measured: it
missed an external importer for 18 modules that plainly have one), which is the trap to avoid
if you ever re-derive this by hand.

## Exemptions that are not defects

- **Compat re-exports are deliberate.** `packages/server/src/services/git.service.ts` and
  `packages/mcp-server/src/git-service.ts` are one-line re-exports of
  `shared/src/lib/git-service.ts` on purpose (`CLAUDE.md`, "Git service — single source of
  truth"). They co-change with it by construction. Do not "fix" them.
- **A module another `shared` module imports stays in `shared`** whatever its external
  consumer count — `exec-result.ts` under `git-exec.ts`, `plugin-placeholders.ts` under
  `plugin-manifest.ts`. 40 of the 108 are in that position.
- **`drizzle/meta/_journal.json` is the single largest crossing file in the repo** (385
  cross-package co-changes). It is generated migration bookkeeping. Every migration touches
  it. It is not a design signal, which is why the script reports the numbers with and without
  mechanical files.
