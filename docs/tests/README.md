# `docs/tests/` — the test-impact map and its durations

Two generated files that make the merge gate's test selection work. Both are **committed on
purpose**, and both have **exactly one writer**.

| File | What | Written by | Refreshed |
|---|---|---|---|
| `impact-map.json` | the test-impact inventory `impact.mjs select` reads to pick which tests a diff can affect | the monitor's `test-impact-map` phase, on the **main checkout** | every cycle in which it has gone stale (~7.4s) |
| `durations.json` | real per-test-file wall-clock times, so `--budget 60s` means seconds | `pnpm test:durations`, by hand | occasionally — durations drift far more slowly than the import graph |

## Why the map is committed (#952)

A stale map does not fail — it **widens**. Past the skill's staleness threshold, `select` silently
drops from the impact tier to the package tier, i.e. the whole package suite, so every saving the
selection buys disappears exactly when the repo is busiest. Measured: the committed map went 146
commits behind in four days.

Worktrees branch from master, so a map fresh on master is fresh in every builder worktree. That is
what makes the selection usable in the card loop at all — the alternative (each worktree rebuilding
its own) costs ~7.4s per card and shares no freshness.

**Committing a volatile generated file is only safe because of the single-writer rule.** The
cautionary precedent is `.claude/smart-hooks-rules.json`, which was force-committed onto master *and
every branch* and so made every merge conflict on it (see `project-scaffold/commit.ts`). Here:

- the monitor phase on the main checkout is the **only** thing that regenerates it — builders in
  worktrees read it and never rebuild (#953 enforces that on the instruction side);
- `.gitattributes` carries `docs/tests/impact-map.json merge=ours` as the backstop for a branch
  that somehow carries an older copy.

> **The attribute alone does nothing.** Git has no built-in `ours` merge driver, and an attribute
> naming an unregistered driver is ignored *silently* — the merge conflicts exactly as if the line
> were absent. `ensureOursMergeDriver` registers it in the main checkout's local git config on each
> pass. `test-impact-map.test.ts` drives a real divergent merge **both** ways, so the two halves
> cannot drift apart unnoticed.

The phase runs **before** the auto-start fan-out (a builder launched that cycle forks from the fresh
map) and takes the **queue repo lock with a short timeout, skipping on contention** — never waiting.
`landMergeTrain` refuses to land a train whose base HEAD moved since assembly, so a commit made
without the lock can kill an in-flight train. A map one cycle stale is harmless; a killed train is
not.

Opt a project out with `test_impact_map_<projectId>` = `off`; turn it off board-wide with the
`test_impact_map_refresh` setting.

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
