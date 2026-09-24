# Pre-merge gate and the test/typecheck loop

_Moved verbatim from the root `CLAUDE.md` on 2026-09-25 (token pass). CLAUDE.md keeps the rules; this page keeps the rationale, incidents and detail. Section headings are the originals._

### Pre-merge gate — tiered, and the always-run guard set is DECLARED, not hand-listed
`packages/server/src/services/pre-merge-gate.service.ts` runs `verify_script` (+ the boot/render
smoke check) before a merge lands. Its test half can be scoped to the packages/files a diff
actually touches (`scripts/test-mine.mjs`, honoring `KANBAN_TEST_PACKAGES`/`KANBAN_TEST_FILES`),
but scoping by import graph (`vitest related`) is blind to any suite that asserts a property of
the whole repo tree without importing what it checks (a spawned hook script, a `MIGRATIONS_DIR`
read, a recursive `readdirSync` scan) — those are exactly the guard/ratchet/parity/scanner
suites, and a hand-maintained "always run these" list silently drifts (#483: 7 of that failure
set were unlisted tree-scanners).

**Fix — classify by declaration.** A suite that reaches state outside its own import graph
carries a top-of-file `// @gate:always-run` marker (see `repo-path-literal-ratchet.test.ts`).
`scripts/test-mine.mjs` builds its always-run set (`ALWAYS_RUN_TESTS`) by scanning each
package's `__tests__` dir for that marker — the list can't drift from what's actually forced to
run, because it no longer exists independently. The companion
`packages/server/src/__tests__/always-run-marker-ratchet.test.ts` is the OTHER half: it
statically re-derives the same "reaches outside its own import graph" signature (spawns a
script under `.claude`/`.codex`/`scripts`, reads `MIGRATIONS_DIR`, or recursively walks a
directory tree) and fails when a matching file carries no marker — so a NEW guard suite can't be
silently unmarked the way the #483 set was. A file that matches the signature but is genuinely
reachable via its own imports (so scoping is safe for it) goes in that test's
`KNOWN_SAFE_UNMARKED` with a one-line reason instead of being force-marked. This is a heuristic
net, not a proof — a suite whose ambient read hides behind a helper won't match the regexes;
accepted, since the marker mechanism only needs to narrow the gap, not close it.

**The marker takes a `when:` precondition, and the floor is ratcheted by TIME (#1041/#1042).**
Measured 2026-09-05 at the `impact` tier on a 9-file branch: the selection was **1 file / ~3s**
and the guard floor **177 files / ~546s** — the half nobody was optimizing was ~99.5% of the
gate's test cost. `@gate:always-run` means "do not scope this BY IMPORT GRAPH", which is not the
same as "run it on every diff", so a marker may name the territory it scans:
```ts
// @gate:always-run when:packages/server/src/routes/**,packages/shared/src/schema/**
```
A bare marker still means always; a `when:` suite is forced only when the change set intersects
one of its globs. Spaces after commas are accepted. An UNKNOWN change set (plain `pnpm test:mine`)
still forces everything; a guards-only docs run retains its known changed paths so the same
preconditions apply. Packages included only to supply guards run those guards, rather than their
whole suite; an unknown scope or an affected source with no coverage still widens verification.
#483's property is intact: the declaration lives in the file, and no hand-maintained
list can drift. Measured savings, cumulative over two scoping passes: routes-only 546s → 357s →
**315s**, scripts-only → 222s → **183s**, client-only → 253s → **223s** (the second pass scoped
eleven more — four client tree-walkers, five `.claude/hooks` spawners, `dev-script` and
`barrel-client-safety` — worth ~42s to any diff outside their territories).
`always-run-guard-runtime-ratchet.test.ts` pins the
summed estimated runtime of the UNCONDITIONAL floor (from the committed
`docs/tests/durations.json`, unmeasured files counted at an explicit 3s and reported), shrink-only
— so a new marker on a 50s suite reads as a 50s decision at review time. The parse rule and the
glob matcher are mirrored in `services/always-run-guard-floor.ts` (a published `packages/server`
cannot import a repo-root script) and held to the same BEHAVIOUR by
`always-run-dirs-lockstep.test.ts`.

**The pass message prices both halves (#1043).** `+14 guard suites` read as a top-up on the
selection when it was the whole run, so "the gate is slow" got attributed to the selection — which
is where the fixes then went. A passing gate now names
`selection kept 1 suite(s)/~3s est … +177 guard suites (~546s est, 15 unmeasured)`; `est` is
stated because these are summed per-file measurements, not a stopwatch on this run, and an absent
duration report omits the estimate rather than inventing one.

**Tier visibility.** `verify_gate_strategy_<projectId>` (`full` | `scoped` | `scoped-base-watch` |
`impact`, default `full` until a base-health backstop exists) is the ONE named pref that replaces the
`verify_file_scope`/implicit-scoping booleans an operator could otherwise misalign. A level may
only weaken verification VISIBLY: a passing gate's message always names what ran, e.g.
`pre-merge gate passed (tier: file-scoped, 3 changed file(s), +14 guard suites, workers 6)` —
never a bare "passed" that hides whether scoping applied.

**`impact` (#956) is the narrowest tier and is STRICTLY OPT-IN** — nobody's default; only the
`iterate` and `flow` risk postures yield it (#983/#1240 — `iterate` backs it with a nightly master
sweep, `flow` with the release candidate's sweep alone), and `standard` never will. It picks the file
half with the test-impact SELECTION rather than `vitest related`, plus the `@gate:always-run` guards
and every test file the diff touches. That last part is not decoration: a test file the branch ADDS is
absent from the committed impact map, so it has no coverage/failure/runtime history — the signals the
score is built from — and could be ranked out by its own newness and never run.

Being opt-in is what lets it exist before #954's miss-rate corpus does: a tier no project selects
cannot weaken any gate, so the corpus gates **promoting** it to a default — a separate, later
decision — not its existence. Do not read a merged #956 as permission to switch the default.

Because what it drops is a ranked GUESS rather than a provable non-dependency, its message carries
more than the tier name: how many suites the selection kept, **how many it dropped below the score
floor**, and whether the impact map was **fresh or STALE** (a stale map makes the skill widen to the
package tier — a different, weaker artifact that must not read the same). An unresolvable selection
prints a loud `selection UNKNOWN`, never silence, since silence would read as "nothing was dropped".
Two env vars carry it to the runner and both are load-bearing: `KANBAN_IMPACT_BASE` (passed to
`select` **positionally** — a gate runs on a clean committed tree, so with no base the change set is
empty and the "selection" is the constant always-run set, the #963 defect again) and
`KANBAN_TEST_NEW_FILES`.

**The selector reaches a worktree by ONE road, and the board now checks it (#1039).** The plugin's
skill is junctioned into the main checkout at enable time and copied into each worktree at
provisioning; when that junction is gone (the checkout moved, the dir was deleted, the pref flipped
by hand) the map still shipped and the tool did not, and nothing said so — the builder's guarded
inner loop was a no-op and the gate quietly used a machine-local `$HOME` copy or fell back to
`vitest related` under `tier: impact`. `materializeEnabledPluginSkills` now re-runs the enable-time
fan-out (`fanOutPluginSkills`, which also replaces a dangling junction) before copying, returns
`{ materialized, healed, missing }`, and warns for a healed or missing skill; the gate message says
`selector ABSENT (<path> is not in the worktree …)` instead of a bare `selection UNKNOWN`, and
`test-mine.mjs` names a `$HOME` hit.


## Inner loop, test:mine and typecheck (from Common Commands)
- **Inner loop (default while editing) — the impact selection, not the package suite (#953).** `test:mine` with no scope runs WHOLE packages, so the "fast loop" on a server-side ticket is thousands of tests; the test-impact skill picks ~6 files in ~0.4s from the same change. Run from the worktree root, guarded because the copy is best-effort:
  ```sh
  [ -f .claude/skills/test-impact/tools/impact.mjs ] && node .claude/skills/test-impact/tools/impact.mjs select --min-score 1.0 --format vitest
  ```
  Then run what it prints. **`select`, never `build`** — the skill resolves its root via `git rev-parse --show-toplevel`, so a rebuild here overwrites the read-only `docs/tests/impact-map.json` snapshot the board copied into your worktree and breaks the single-writer property; keeping the map fresh is #952's job on the main checkout, where the map lives as a gitignored artifact (#1018 — it is no longer committed, so it is also no longer inherited by branching; the board copies it in at provisioning and on relaunch). If it is absent, `select` widens to the package tier and says so. **A green impact selection is NOT a green gate** — it is a ranked guess that narrows the run, so it tells you an edit did not obviously break something, nothing more.
- `pnpm test:mine` — fast loop (green unit suites; skips known-flaky). Takes `-- --changed HEAD` and patterns. **This is the gate**, unchanged: run it (and the full `pnpm --filter agentic-kanban test` for cross-cutting changes) before mark-ready, whatever the impact loop said. `KANBAN_TEST_SELECTOR=impact` swaps its `vitest related` scoping for the same test-impact ranking (opt-in, fail-open, #951) — not the default until #954 has produced a measured miss rate.
- **`pnpm typecheck` is `scripts/typecheck.mjs`, not an `&&` chain (#980).** It runs the five typed
  packages with bounded concurrency (`KANBAN_TYPECHECK_WORKERS`, default **2** — each `tsc` peaks
  around 0.5-1 GB and this box runs several agents, so a worker-per-core default is how one run
  takes the machine down) and an incremental cache under each package's `node_modules/.cache/`.
  Measured on an idle box: **54s serial → 37s cold → ~10s warm**. It prints
  `[typecheck] 37s total across 5 package(s), 2 worker(s): server 33s, client 21s, …` so the
  pre-merge gate's FLOOR stays measured rather than guessed — with the test half budgeted at 120s
  (#966/#967), arch+typecheck was most of a small change's gate. `pnpm typecheck:serial` is the old
  chain, kept for bisecting a suspected concurrency artifact. A new package with a `tsconfig.json`
  must be added to `PACKAGES` there; `typecheck-package-coverage.test.ts` fails if it is not.
