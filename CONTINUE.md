# Continue

Where to pick this up. Present-tense, current state only — see `BACKLOG.md` (exported from
the board, `pnpm cli -- backlog export`) for candidate future work.

## Declared "batch 1" refactors — true state (#691)

Three commits declared themselves a partial pass ("batch 1", "N remain") with no follow-up
ticket and no line in this file, so the remainder was invisible until re-measured by hand.
Recorded here so the next session doesn't have to re-derive it:

- **#569 (wire-DTO dedup, `c0bba1eef1`)** — batch 1 moved the agent-questions family,
  `OrchestratorStatus`, the scorecard pair, `IssueComment`/`IssueCommentKind`, and the
  preflight family into `shared/`: 75 duplicated names → 62 (measured directly against
  `packages/shared/__tests__/wire-dto-single-declaration.test.ts` `GRANDFATHERED`, not the
  ticket's own prose, which stated two different totals). **Correction (2026-08-22 review): the
  number is 61, not 62** — 62 was the figure in the prose comment above the declaration, so this
  entry made the exact error it was written to prevent. The #704 section below says 61 correctly. **Verified low-risk to leave
  partial**: a real shrink-only ratchet exists (`GRANDFATHERED` may only shrink; a NEW
  duplicate fails the suite), so the remainder cannot silently regrow — but it also isn't
  shrinking on its own. Follow-up ticket #704 files the mechanical migration.
- **#591 (one `ExecResult` shape, `80189f31af`)** — `execSucceeded`/`execFailedToRun`/
  `execErrorMessage` (`packages/shared/src/lib/exec-result.ts`) are structurally sound and
  typecheck-clean, but have **0 non-test callers**; 42 hand-rolled `.code === 0` /
  `!== 0` / `=== null` checks remain, including `workspace-services.service.ts:231,250,261,275`
  writing `res.code === 0` on the same lines that call `execErrorMessage(res)`. **No ratchet
  exists for this one** — unlike #569/#513 there is nothing stopping a new hand-rolled check
  from being added today. Follow-up ticket #705 covers both the migration and adding a
  shrink-only ratchet analogous to `wire-dto-single-declaration.test.ts`.
  > **SUPERSEDED — do not act on the present tense above.** #705 landed (`dd901d01e1`): the
  > helpers now have 64 call sites across 15 files, hand-rolled checks are down to 8 (all the
  > `plugin-exec` different-shape exception), and `exec-result-helper-adoption.test.ts` is the
  > ratchet. Verified 2026-08-22. The paragraph is kept for the #691 audit trail only.
- **#513 (`useApiResource` hook, `51a928e120`/`8333db7e2f`)** — the commit message said "35
  ladders remain"; the actual count via
  `packages/client/src/__tests__/fetch-in-effect-ratchet.test.ts` is baseline-tracked per file
  (89 files at introduction, currently higher than 35 by the file-count measure). The ratchet
  itself is sound (down-only, fails on any new ladder or a stale/lowered baseline entry not
  updated) — the gap was only the commit message's stated count, not a missing enforcement
  mechanism. No further action beyond what #690 already tracks for the related ladder work.

## Process fix adopted

`CLAUDE.md` § "Scope Discipline" now requires: a commit that declares itself a partial pass
("batch 1 of N", "N remain", "the rest is a mechanical follow-up") must, before it merges,
either (a) add or point at a shrink-only ratchet test that fails if the remainder regrows, or
(b) file a follow-up ticket referencing the original ticket number. Neither existing alone
(as #591 shows for "neither", #569 shows for "ratchet but no ticket") is treated as
disclosure — both #704 and #705 were filed as part of landing this ticket to make the rule
concrete on its own first two instances.

## In-flight wave landed (session 2026-08-21)

Nine tickets reached master. (**Correction**: the table below lists eleven — #699 and #679
are counted in it but not in the "nine".) Six were In Review and merged; three had **stranded
uncommitted work** in idle workspaces whose agents died without committing — the work
existed only in the worktrees and would have been lost when they were reaped.

| # | What | Landed as |
|---|---|---|
| #672, #673, #674, #690, #691, #695 | were In Review | six merge commits |
| #689 | PassReport summary emitted, not just built | `ec99e938f2` |
| #688 | line coverage measurable + 5 untested files covered | `fe1d1ee49f` |
| #685 | stuck `pending`/`running` install is reclaimable | `685fe33d66` |
| #699 | `createWorktree` no longer deletes a LIVE worktree | `3d7e915c73` |
| #679 | gate stops excluding seven suites | `159a65d958` + `0ad6497aec` (direct on master) |

**All three stranded branches were red on repo guards as handed over** — which is most
likely why their agents stalled — and each was fixed rather than exempted:

- #689's `console.log(formatPassReport(...))` is untagged by the console-tag ratchet's
  regex (first argument is a call, not a `[` literal); four such lines would have pushed
  that guard 21 → 25. `formatPassReport` is now the tagged wrapper over a new tagless
  `formatPassReportBody`, so a sweep with an injected `log` (which already applies the tag)
  and one without are both expressible.
- #685 introduced a third injected-clock spelling (`now?: number`, capped at 17 by #614) →
  renamed to the canonical `nowMs?: number`; and its new sweep needed adding to the pinned
  `BACKGROUND_SERVICES` order, which is the deliberate act that guard exists to force.
- #685 then conflicted on rebase (`background-services.ts` import block, both sides
  additive) — resolved keeping both, re-verified, merged.

### Verified

**Full suite green at `0ad6497aec`, all four packages**, run per package with the gate's own
exclusion list applied (so #679's seven re-included suites DID run):

| Package | Files | Tests |
|---|---|---|
| shared | 92 | 912 |
| server | 674 | 6127 passed, 4 skipped |
| mcp-server | 42 | 191 |
| client | 153 | 1378 |

Two caveats worth knowing before trusting a red result here:

- **mcp-server flakes on contention, not on code.** At `--maxWorkers=6` two suites failed
  with `Hook timed out in 60000ms` in `beforeAll` (`get-context-boundary.test.ts` among
  them); each passed alone in 16s, and the whole package passed at `--maxWorkers=4`. That
  package's fixtures build real temp SQLite DBs in `beforeAll`, so the 60s hook budget is
  what gives out under parallelism — not the assertion.
- The server run needs more than 10 minutes now that #679 returned seven suites to it.

Per-ticket before merge: #689's emission test proven to bite (removing the log line fails
it, restored); #685's five guards pass; #688 `pnpm typecheck` clean workspace-wide plus its
new suites; #679's seven re-included suites pass together (193 tests, ~78s).

### Two things deliberately NOT done

- ~~**#681 half B**~~ — was left open here as not implemented; it landed later in the same
  session as `ede3021258`. See "#681 is now closed too" below. The rejected cheap substitute
  (a base-health *streak* alarm without per-suite attribution) stayed rejected — the shipped
  version does carry the per-suite attribution that is the ticket's whole point.
- **`pnpm install` for #688's new devDep** — `@vitest/coverage-v8` is in `package.json` and
  the lockfile but not in this checkout's `node_modules`, so `pnpm test:coverage` needs an
  install first. `pnpm test` / `test:mine` are unaffected (verified — the full suite above
  ran after the merge).

### Master has DIVERGED from origin — ahead 68, behind 38 (not "50+ ahead")

Corrected 2026-08-22 (`git fetch` + `git rev-list --left-right --count`). This is not an
unpushed fast-forward: `origin/master` carries 38 commits master lacks — the #996–#1003
fork/workflow line plus the worker Windows service, landed as GitHub PRs #6/#7/#8. A plain
`git push` is REJECTED today.

Integration facts, all measured:
- Only 4 files are touched by both sides, and our side of each is small (`workflow-fork.service.ts`
  +8/-1 against their +135/-26; `workflow-fork.repository.ts` +13/-1; `server-start.ts` +20/-1;
  `route-setup.ts` +12/-0). `git merge-tree --write-tree` reports a CLEAN merge.
- Nothing unpublishable on our side: zero credential-shaped additions; 5 machine-path strings,
  all doc narrative or path-comparison test fixtures.
- `node scripts/check-god-modules.mjs` on our master: **OK, 1410 files, exit 0**.
- But the merge tree resolves `exit-workflow.ts` to **1048 lines**, so `pnpm check:arch` fails on
  the merge result with certainty — see the #700 correction above. `MAX_LINES = 1000` has no
  exemption path.

**Recommended order** (still the operator's call to execute): reopen #700 → merge
`origin/master` locally → fix the three god-module breaches on the merged tree → verify full
`pnpm check:arch` → then push (branch + PR for the audit trail). Do NOT push first: a PR today
is checked against an already-red base, so `arch-gate` fails for reasons unrelated to this
work, and a direct push puts our name on the red master.

### Incidental findings

- ~~**#700 is stale**~~ — **THIS WAS WRONG, and #700's own triage note said so in advance**
  ("do not close it as done"; the 1048-line file lives on the fork-workflow branch). Nobody
  shrank anything: local master never contained the breach. `exit-workflow.ts` is 967 lines
  HERE and **1048 on `origin/master`**, where `arch-gate` has been failing since 2026-08-20
  (verified via `gh run list`: the god-module gate names `exit-workflow.ts` 1048 lines,
  `WorkflowBuilder.tsx` 22 fns, `workflow-fork.repository.ts` 34 fns vs a baseline of 33).
  A gate verified green on local master was read as evidence about a file local master has
  never held. **#700 should be reopened**; it blocks the origin integration below.
- **A real bug was found while chasing killed test runs, but it was not the cause.**
  `1ec5a2269e` is genuine and worth keeping: the base-branch health sweep re-armed on every
  `tsx watch` restart, so a run of merges had it starting a SECOND complete
  `check:arch && typecheck && test:mine` on the main checkout alongside the developer's
  own. `tickInFlight` cannot catch that — it guards a pass against itself within ONE
  process, and each pass was in a freshly restarted one. Now gated on persisted recency,
  which a restart cannot forget.
  **But a third run was killed with that fix in place**, so the sweep was at most a
  contributor. The actual pattern: every killed run was a BACKGROUND run whose kill
  coincided with the agent's turn ending; the runs that completed were the ones being
  worked alongside. Treat a long suite run as foreground work, or keep the session active
  while it proceeds — do not diagnose the next one as a server bug without checking that
  first.

## The four follow-up tickets are landed (session 2026-08-21, continued)

Direct on master (mode 1), one commit each, after the wave above:

| # | What | Landed as |
|---|---|---|
| #708 | orphaned agent-session registry files are reaped | `6a06c665fe` |
| #705 | `ExecResult` helpers have real callers, and a ratchet keeps them | `dd901d01e1` |
| #707 | every `process.env` read has a stated owner | `4c1d7953a5` |
| #704 | 45 of 61 grandfathered wire DTOs collapsed to one declaration | `ebf1f626dd` |

Three of them close the loop this file opened above: #704 and #705 are the follow-up
tickets #691 required, and #707 replaces the "not yet a complete inventory" caveat on
`docs/env-vars.md` with a gate.

**What each is worth knowing about:**

- **#708** is a background sweep, not a kill-site hook, because the board is not the only
  source of orphans (a crash, `killAll`, a hard reboot, a `SIGKILL` of the board itself all
  leave files behind) and a hook could not have removed the 48 already on disk. A file whose
  PID is now recycled onto a live process is a deliberate **keep**: deleting one that might
  describe a running session is the worse error.
- **#705** migrated 38 hand-rolled `.code === 0` checks across 14 files (the commit said 13). The `execErrorMessage`
  caller floor is 3, not the 5 first written — the extra `${x.error}` sites found were domain
  result objects with a string `error`, not `ExecResult`, so the floor was lowered to the
  honest count rather than met by inventing migrations. Floors are floors, not targets.
- **#707** deliberately has **no grandfathered baseline**, against the ticket's own
  suggestion: a frozen "these N are undocumented" set is a budget that reads green while the
  debt sits. Both categories were answerable today. Its stale-FOREIGN check then caught six
  entries in its author's own first draft (`ANTHROPIC_*`, `CODEX_HOME`, `NODE_ENV`, `VITEST`,
  `npm_execpath`) that the tree does not read as `process.env.X` — they reach an agent through
  the spawn-env object `buildSpawnEnv` builds. The ticket's numbers were also stale: 62 reads /
  34 names / 27 files today, not 84 / 42 / 32.
- **#704** is a partial pass by design and 16 names stay grandfathered. Five of the 45 were
  genuinely drifted and are resolved rather than moved blindly — the commit message names
  each and which side won. The remaining 16 are where drift is a decision, not a subset.

Every new guard was **proven to bite** before being trusted: a hand-rolled `.code !== 0`
reintroduced for #705, and `KANBAN_FAKE_UNDOCUMENTED` / `SOMEONE_ELSES_VAR` added to
`pid.ts` in turn for #707. All restored.

### Verified at `ebf1f626dd`

| Package | Files | Tests |
|---|---|---|
| shared | 96 | 934 passed, 2 skipped |
| client | 153 | 1378 |
| mcp-server | 43 | 204 |
| server | 682 | 6241 passed, 4 skipped |

`pnpm typecheck` clean across all four packages, and the client production build succeeds —
the latter is what proves #704's re-export shims did not become runtime value imports.
mcp-server was run at `--maxWorkers=4` for the contention reason recorded above.

### #681 is now closed too — half B landed

`ede3021258`. The previous session left it open with a design comment saying half B "needs
per-suite outcome persistence across probes — a real feature, not a follow-on edit". That was
right, and this is that feature:

- `base_branch_health.failed_suites` (migration **0126**) stores the suite list parsed from the
  FULL verify output, before the 40-line tail that becomes `message` throws it away.
- `null` vs `[]` is load-bearing and is the part to not "simplify" later. `[]` = a probe that
  produced a per-suite verdict and named nothing (a green run — the value that BREAKS a red
  streak). `null` = a probe that could not speak about suites at all (timeout, unverified, a red
  run that died in `tsc` before vitest started, or any row predating the column). The detector
  skips nulls rather than treating them as a pass.
- `findRottedSuites` reports a suite red across ≥2 consecutive verdict-bearing probes; a suite
  green NOW is never reported, however long it was red before.
- Fourth `MonitorWarning` member, one warning per project.

**Scope is deliberately wider than the ticket's wording** ("any `@gate:always-run` suite"): it
reports every suite. The marker tells a SCOPED run what it must not skip, and the base-health
probe runs the whole verify script, so every suite in it is equally observed. Gating on the
marker would narrow the alarm AND require re-deriving the marker set from the tree at runtime —
a second copy of the scan `scripts/test-mine.mjs` owns. All four measured rot cases are guard
suites and are caught either way.

**What is verified, and what is not.** The decision function, the parser and the column
round-trip are covered by 24 tests, and the parser was run against REAL vitest output both ways
(the 47KB all-green server log → `[]`; a deliberately-failing temp suite → named exactly). Full
suite green on top of `ede3021258`: server 683 files / 6265 passed + 4 skipped, shared 96/934,
mcp-server 43/204, client 153/1378; typecheck clean; `pnpm check:arch` 0 errors.
**Live so far**: the dev server hot-reloaded onto the new code, applied migration 0126, and
`GET /api/projects/:id/base-branch-health` now returns `failedSuites` — `null` on all 20
pre-existing rows, which is exactly what the column's null-vs-`[]` rule says a row written
before it existed should read as. **Still unobserved**: no probe has run SINCE, so no row
carries a non-null list and the warning has never fired against live data. This board's probe
does run (the newest row is a 951s red against `6a06c665fe`), so the next one is what closes
the loop — check `failedSuites` on the newest row rather than assuming.

### Two things about RUNNING the server suite here, both learned the hard way

- **A background run of it gets killed.** It happened twice more this session, always to a
  `run_in_background` run and never to a foreground one — the same pattern the "Incidental
  findings" note above describes. The reliable way to run all 683 server files is **eight
  foreground shards**: `pnpm exec vitest run --maxWorkers=4 --shard=N/8` from
  `packages/server`, each ~5–8 min, which fits the foreground timeout. Sum the per-shard
  numbers; they add up to the same total (761+548+818+910+818+783+818+809 = 6265 + 4 skipped).
- **`merge-response-before-cleanup.test.ts` flakes under full-suite parallelism.** One of its
  10 tests failed in a full run and passed both in isolation and across all eight shards; the
  same window carries `[resource-sweep] process enumeration failed`. It is NOT on the
  `test-mine.mjs` exclusion list and should not be added to one on this evidence — a single
  observation. Re-run it in isolation before treating it as a real failure.

## Adversarial review of the 2026-08-20/21 wave (2026-08-22)

Four independent reviewers over the 68 commits `origin/master..master`, instructed to distrust
this file. Everything below was reproduced or measured directly — claims the reviewers could not
execute are not listed. The corrections they forced are already folded into the sections above.

**The dominant pattern: the prose is doing the reviewing, and it is a different artifact from the
code.** Repeatedly, a long and correct rationale sits directly above code that violates the
invariant it declares. Second pattern: **the fix lands at one call site of N**, with the commit
disclosing a smaller remainder than exists — which is #691's own batch-1 rule, unapplied by the
wave that wrote it.

### Confirmed defects, highest first

1. **#681 half B: a red probe can persist a false GREEN per-suite verdict.** Reproduced against
   the real module: `failedSuitesForOutcome("red", out)` returns `[]` whenever `out` carries a
   `Test Files` summary but no FAIL lines — and `[]` is what the schema comment and
   `findRottedSuites` both define as the value that BREAKS a red streak. Reachable because the
   derived verify is `chainAll(typecheck, test, build)`: build runs AFTER vitest, so any
   build-stage failure emits a passing `Test Files` line. Correct value is `null`. **A test pins
   the wrong behaviour**: `rotted-suite-scan.test.ts:160-164`.
2. **#681's scope justification is false.** `rotted-suite-scan.ts:19-24` (and this file, and the
   commit message) claim "the probe runs the whole verify script, so every suite is equally
   observed". `verify-command.ts:194` prefers `quickTestCommand` = `pnpm test:mine`, which excludes
   suites by design — and the live probe output proves it, containing
   `[test:mine] mcp-server: node vitest run --exclude **/mcp-tools.test.ts`. Excluded suites can
   rot forever, invisibly.
3. **#681 reports false suite names.** A test whose NAME contains a path is attributed as a failed
   suite — reproduced: a `×` line reading "parses paths in src/__tests__/other.test.ts correctly"
   yields `["src/__tests__/other.test.ts"]`. Worst case in a repo full of ratchets that cite paths
   in their test names; the commit's own standard is "a false name is worse than no name".
4. **`startup/` has no persistence boundary, and the wave widened it.** Verified: 31 of 32
   `startup/` files import `drizzle-orm` directly; `services/` does so **zero** times. The rule
   that would catch it, `startup-bypasses-repositories`, is pinned `warn` so it can never block,
   and the wave added a new offender (`install-staleness-reconciler.ts`). Largest live layering
   breach in the repo; the only invariant of this size with no ratchet.
5. **`shebang-eol-guard` is green while the bug is on disk.** It asserts the `.gitattributes`
   attribute and explicitly refuses to look at bytes. Verified: tracked shebang files still carry
   CRLF working-tree bytes, including `scripts/board-monitor/loop.sh` (`attr/text eol=lf`,
   `w/crlf`) — the Conductor loop — and all eight `.claude/hooks/*.js`. `.claude/skills/**` has
   been pinned since #217 and is still CRLF, i.e. the pin demonstrably does not repair an existing
   checkout. Fix is `git add --renormalize`, plus a byte-level assertion.
6. **`formatPassReport` has zero production callers.** Verified: all five real emission sites call
   `formatPassReportBody` and hand-write the tag; the tagged wrapper is referenced only by tests
   and a comment. Dead code created BY a guard (the console-tag ratchet's first-argument rule) —
   the exact defect #591/#705 exist to catch, and no ratchet cross-checks guard-mandated helpers.
7. **Single-spelling ratchets.** Each defends the one shape the past bug took, not the class.
   Probed and GREEN (i.e. undetected): `res.code > 0`, `!res.code`, destructured `code === 0`,
   loose `res.code == 0` for #705's guard; `asOf`/`currentTimeMs` for the time-spelling ratchet
   (so CLAUDE.md's "adding a tenth spelling fails that gate" is false); a `VITE_PORT` fallback for
   the new client-port guard — the very miss #690 was filed to fix on the server side; and
   `env.NAME` after `const env = process.env` for #707 (34 live sites, so coverage SHRINKS as the
   code improves toward injectable env). None of these guards use the TS AST.
8. **Fixes wired at one site of N**: #699's `isPathClaimed` at 1 of 8 (the unwired ones include
   `workspace-crud.service.ts:220`, literally #699's own scenario); #673's co-residency delete
   guard at 1 of 5; `a2efe48691`'s closed-sharer correction at 1 of 2 — and both copies compare a
   literal `"closed"` instead of `isTerminalWorkspaceStatus`, so an `error`-status workspace counts
   as a live sharer forever.
9. **#685's reclaim `UPDATE` has no `installState IN ('pending','running')` predicate** and runs
   against rows from an earlier `SELECT`; with no heartbeat, a legitimately long install is
   reclaimed mid-flight and a `done` row can be clobbered to `failed`.
10. **#673's create guard is keyed on `issueId + branch`** while the worktree path collapses to
    `ak-N`, so it deliberately exempts the exact pair that collides. In-process `Set`, no unique
    constraint, no TTL — a create hung in `setupWorktree` wedges `409` for the process lifetime.
11. **#709's Stop hook silently reports NOTHING for two common paths**: subagent writes
    (`WRITE_TOOLS` has no `Agent`, and the subagent's transcript is never recursed into) and a
    `sed -i` issued after a `cd` into a package (attribution compares repo-relative paths).
    Meanwhile `cat`/`grep` of a file makes you its author — unreliable in both directions.
12. **The base-health probe has no in-flight lock on a deterministic temp dir**
    (`base-branch-health.service.ts:78`), removes it recursively before cloning, and has two
    callers — the sweep and a fire-and-forget probe after EVERY merge. Probe B wipes A's tree
    mid-verify and the wreck records as `outcome: "red"`. A strong candidate for the
    "199 red, 0 green" figure this repo cites as #674's evidence.

### Aggregate quality verdict

Measured shape of the wave (+9511/-1325, 220 files): 52% test code (15% of that tests ABOUT the
repo), 33% production `src/` — of which 24% is machinery whose only consumer is this repo's own
merge button — 9.5% process prose, and **0 new API routes, 0 MCP tools, 0 client views**.
`check-god-modules.mjs` was not loosened, but 13 files sit parked at 900-999 against the 1000
ceiling and 16 of the top 17 largest files were untouched. Reconcilers went 23 to 27; all four new
ones compensate for state the primary write path does not keep consistent.

Genuine wins, independently confirmed: **#679** (138 lines re-included 7 suites / 193 tests
covering defects that had each already shipped once — best value-per-line in the range), **#704**
(61 to 16 duplicate DTOs at net **-139 LOC**), **#705** (0 to 64 helper call sites; 42 to 8
hand-rolled checks, the 8 correctly a different type), and **#687**'s reverse-direction marker
check, the one guard that defends the guard mechanism itself.

Least value: the self-improvement machinery was, in this window, a net source of gate
unreliability — four board-wide merge outages in ~48h, all caused by the gate/guard mechanism and
none by a product regression. `7675044331` (an empty-message automated commit) corrupted a test
file into non-parsing, silently killing the whole `base-branch-health` suite including the #674
regression test added in that same commit. And **#688** spent 965 lines making coverage measurable
with no threshold, no baseline and no gate.

Cost now imposed on every merge: `KANBAN_TEST_GUARDS_ONLY=1` gives **98 suites / 578 tests /
~2m20s**, a fixed floor immune by construction to the `scoped` tiering that exists to make the
gate cheap. Two of those suites were red on master inside this same window, and a red always-run
suite blocks every merge board-wide.

## Next steps

**The board is empty of open ISSUES** — 0 Backlog, 0 Todo, 0 In Progress. **Not 0 workspaces**
(corrected 2026-08-22): 3 idle `agentic-kanban` workspaces from July (#141, #148, #183), 57
non-closed board-wide, and `git worktree list` shows 24 worktrees of which ~20 are stale
(7 locked, one at sha `0000000000`, 4 prunable). Run the `cleanup` skill.
(#709 was filed by another session mid-way through this one and is now Done). Everything below
is either done or a decision that is not this session's to make.

- [x] Full suite verified green at `0ad6497aec`, and again at `ebf1f626dd` (all four packages)
- [x] #700 verified stale and closed (`exit-workflow.ts` is 967 lines, gate exits 0)
- [x] #704, #705, #707, #708 implemented and closed — see the section above
- [x] #681 half B landed (`ede3021258`); #681 closed
- [x] **#709 landed (`5ef076b79c`) and closed** — the Stop hook's main-checkout branch now
      attributes the dirty set to the stopping session's own transcript before it warns.
      It had no notion of authorship, so in this shared checkout it reliably blocked an
      uninvolved session and handed it another agent's in-flight work — pressure toward
      exactly the cross-author commit the root CLAUDE.md names by hash. Unknown authorship
      (unreadable transcript) still reports EVERYTHING; only silence would have been a
      regression. The `restore` branch (#771 deletion-desync) is deliberately unfiltered.
      Verified live both directions against a genuinely dirty tree, plus 7 new tests.
- [ ] **Push master** — recommended, but only after the origin integration and the three
      god-module fixes. See the corrected divergence section above for the order and why
      pushing first is the wrong move.
- [ ] `pnpm install` so #688's `pnpm test:coverage` can run. Left undone on purpose: it mutates
      a shared checkout while a dev server is running.
- [x] **#681 half B confirmed end-to-end on live data (2026-08-22)** — probes have run since.
      Greens store `[]`; this project's newest row (`d7be0289a4`, 2026-08-22T05:55Z) stores
      `["src/__tests__/leaked-temp-project-cleanup.test.ts"]`, and **12 consecutive probes**
      back to 2026-08-21T18:55Z carry that identical list, so `findRottedSuites` yields a
      streak of 12 against a threshold of 2. The parse is accurate, not a false positive (the
      stored tail shows `(3 tests | 2 failed)` with two `×` lines). Wiring verified:
      `monitor-setup.ts:212` inside `refreshMonitorWarnings`, reached from `syncMonitorState`
      INDEPENDENTLY of `monitorShouldRun`, so conductor-mode projects are covered.
- [ ] **Master HEAD is RED — fix `leaked-temp-project-cleanup.test.ts`.** It passes in the main
      checkout (3/3, 16s) and fails 2 of 3 in the probe's clone, because the probe clones to
      `%TEMP%\kanban-base-health-<projectId>-master`, so the test's deliberately
      missing-but-NOT-temp fixture is itself under `%TEMP%` and gets classified as leaked. Every
      "full suite green" table in this file was measured in the one environment where this
      cannot fail.
- [ ] Nothing further open on #691 itself — this file + the CLAUDE.md rule + the two
      follow-up tickets (both now landed) are the complete fix.
