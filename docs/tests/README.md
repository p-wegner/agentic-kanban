# `docs/tests/` — the test-impact map, its durations, and the guard inventory

Generated files about the test suite. Each has **exactly one writer**. Two are committed on
purpose; the map is deliberately **not** (see below).

| File | What | Written by | Refreshed | In git? |
|---|---|---|---|---|
| `impact-map.json` | the test-impact inventory `impact.mjs select` reads to pick which tests a diff can affect | the `test-impact-map` pass, on the **main checkout** | on every landed merge, plus every sweep in which it has gone stale (~7.4s) | **no** — gitignored (#1018) |
| `durations.json` | real per-test-file wall-clock times, so `--budget 60s` means seconds | `pnpm test:durations`, by hand | occasionally — durations drift far more slowly than the import graph | yes |
| `guard-inventory.md` / `.json` | one row per `@gate:always-run` suite and per `*ratchet*.test.ts`: the property it pins, when it was introduced, a proxy for when it was last red, its wall time, and a candidates list (#1022) | `pnpm guard:inventory`, by hand | when the standing guard set is being audited — it is a REPORT, and it removes nothing | yes |

## Why the map is NOT committed (#1018)

A stale map does not fail — it **widens**. Past the skill's staleness threshold, `select` silently
drops from the impact tier to the package tier, i.e. the whole package suite, so every saving the
selection buys disappears exactly when the repo is busiest. Measured: an unmaintained map went 146
commits behind in four days. Keeping it fresh is therefore a real job, and #952 gave that job to a
board pass on each project's **main checkout**.

That pass used to **commit** each rebuild — `chore: rebuild test-impact map @ <sha>`, 11 of 261
commits in the measured window. Every one of them moved the base tip under whatever pre-merge gates
were running, and #243 correctly *discards* a gate verdict whose base moved: one measured casualty
was a gate that PASSED after 590 seconds and was thrown away by this pass's own chore commit. #998
deferred the rebuild while a merge was in flight, which narrowed the window without removing the
mechanism.

So the map is now an **untracked, gitignored artifact**, rebuilt in place. The chore commits are
gone, and with them the `merge=ours` driver, the `.gitattributes` line, and the merge deferral —
an untracked file cannot conflict and cannot move a base.

**What replaces "worktrees inherit it from master":**

- the board **copies** the main checkout's map into each worktree at provisioning **and at
  relaunch** (`services/test-impact-map/worktree-map.ts`), so a builder gets a snapshot rather than
  a moving target, and a resumed workspace picks up a fresher one;
- the same `.gitignore` line covers the copy, so it never lands in a branch diff and never leaves a
  worktree dirty (which `workspaceLaunchPreflight` would refuse to relaunch);
- **absent is a supported state.** A fresh clone has no map until the first sweep. `select` then
  widens to the package tier and says so on its own line — a wider run, never a wrong one.

**A worktree still never writes the map.** `KANBAN_IMPACT_REBUILD` is off by default for exactly
that reason (`scripts/test-mine.mjs`), and the pass itself only ever runs against a project's
`repoPath`.

**Opting in is `git check-ignore`.** Before writing, `resolveMapWritability` asks git two questions:
is the path *tracked* here (→ refuse; a rewrite would dirty main and stall the merge queue), and is
it *ignored* here (→ required; an untracked-but-unignored file has the same effect). A repo that has
not gitignored the path is left alone, and a checkout that still tracks the map is reported with the
one-time remedy — `git rm --cached docs/tests/impact-map.json` — rather than silently skipped.

The pass runs **before** the auto-start fan-out (a builder launched that cycle gets the map that was
just rebuilt) and takes the **queue repo lock with a short timeout, skipping on contention** — never
waiting. The lock is no longer about commits: it is what stops two overlapping rebuilds interleaving
into a half-written map.

Opt a project out with `test_impact_map_<projectId>` = `off`; turn it off board-wide with the
`test_impact_map_refresh` setting.

### What triggers a refresh, and the bound that follows (#1046)

Three triggers, all writing through the same pass on the main checkout:

| Trigger | Where | Decides staleness by |
|---|---|---|
| monitor phase, before the auto-start fan-out | `startup/monitor-test-impact-map.ts` (#952) | `impact.mjs check` |
| background sweep, every 15 min — covers a `manual` project no cycle visits | `startup/test-impact-map-reconciler.ts` (#993) | `impact.mjs check` |
| **a landed merge**, in the lock-free post-merge tail | `services/test-impact-map/post-merge.ts` (#1046) | its own bound, then `impact.mjs check` |

The first two defer entirely to the tool, whose threshold is deliberately generous
(`staleWidenAfterCommits` = 30). That is why a map measured 23–24 commits behind was still "fresh"
to all of them and nothing rebuilt it: the trigger existed, the answer was just always *no*, and the
day it flipped the gate widened to the package tier with a one-word signal nobody was reading.

The merge trigger applies a tighter bound of its own — `IMPACT_MAP_MAX_COMMITS_BEHIND` (**10**) —
counting `<map stamp>..HEAD` itself and forcing a rebuild past it. So the guarantee is statable:
**after a merge completes, the map is at most 10 commits behind that project's HEAD.** Below the
bound it still asks the tool, because a merge that ADDS a test file makes the map stale at one
commit behind and only the tool sees that.

It skips on repo-lock contention (a merge train's next landing is never held behind a rebuild) and
never rebuilds from a worktree, so single-writer is unchanged.

### A stale map is no longer a silent widening

When the gate's selection does run on a stale map, both the merge message and the server log now say
what it cost and what to do: `map STALE — a stale map WIDENS the selection to the package tier … `
`rebuild it on the project's MAIN CHECKOUT with node .claude/skills/test-impact/tools/impact.mjs `
`build --durations docs/tests/durations.json (never from a worktree)`.

### What "fresh" means for a file that is not in git

Unchanged, and it never depended on tracking: `impact.mjs check` compares the map's **own recorded
`commit:` stamp** against HEAD (`git rev-list --count <stamp>..HEAD`) and against the test files
changed since. Fresh = the stamp is reachable, within `staleWidenAfterCommits` (30) commits of HEAD,
and no new test file has appeared. The merge gate's `map fresh` / `map STALE` clause therefore keeps
meaning exactly what it meant before — and it now describes the **worktree's** copy, which is the
map the run actually used.

One consequence worth naming: because the map left the tree, a rebuild no longer changes
`mergedTreeHash` and so no longer invalidates a banked gate pass by itself. `resolveSelectorId`
closes that by appending the map's stamp to the memo's selector component (#958's third field), so
two runs on the same tree with different maps do not share a banked green.

### Why "commit it once a day, before promotion" lost

The considered alternative was to keep the map committed but write it exactly once a day,
immediately before promotion (`scripts/promote.mjs`, #1014), never from the 15-minute pass. It is
the smaller change and it does cut ~11 commits/day to 1. It lost on three counts:

1. **It designs the staleness in.** This repo lands well over 30 commits a day, which *is* the
   skill's staleness threshold, so a once-a-day map would spend most of every day widened to the
   package tier — the #993 failure, made permanent rather than accidental.
2. **It keeps the mechanism.** A promotion-time commit still moves the base under a running gate.
   The failure becomes rare, and a rare base-movement bug is harder to attribute than a frequent one.
3. **It keeps 1.4 MB of generated JSON** in every branch diff, rebase and `git log -p`, for a file
   no human reads.

## Refreshing the durations (#955)

Without a durations report, `select --budget 60s` prints `duration unmeasured (budget assumes
3s/file)` — the budget is *files x 3s*, not time. Two consequences: a "60s" tier can be minutes, and
ranking is `score / durationMs` against a constant denominator, so a slow high-signal suite and a
fast one rank identically.

```
pnpm test:durations                              # run every package, write docs/tests/durations.json
node scripts/capture-test-durations.mjs --merge a.json b.json   # merge reports you already have
```

Then commit `durations.json`. The monitor re-feeds it on **every** rebuild
(`impact.mjs build --durations …`) — that is not optional bookkeeping: `build` reads durations only
from that flag and never carries them over from the previous map, so a rebuild without it would
silently erase every measured time and return the budget to its estimate.

The suite is ~7,000 tests and has been observed at ~15 min under contention, so run this where a
full run is happening anyway rather than adding one. Prefer a quiet machine: times recorded under
contention encode the contention, not the suite.
