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
  `packages/shared/__tests__/wire-dto-single-declaration.test.ts:40` `GRANDFATHERED`, not the
  ticket's own prose, which stated two different totals). **Verified low-risk to leave
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

Nine tickets reached master. Six were In Review and merged; three had **stranded
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

### Master is 50+ commits ahead of origin and NOT pushed

Deliberate: it carries other agents' merged work on a public repo, so pushing is the
operator's call, not this session's.

### Incidental findings

- **#700 is stale** — `exit-workflow.ts` is 967 lines and `check-god-modules.mjs` exits 0;
  the ticket says it is 1048 and over the 1000 ceiling. Someone shrank it without closing.
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
- **#705** migrated 38 hand-rolled `.code === 0` checks across 13 files. The `execErrorMessage`
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

## Next steps

**The board is empty of open work** — 0 Backlog, 0 Todo, 0 In Progress, 0 workspaces
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
- [ ] **Decide whether to push master** (60+ commits ahead of origin, other agents' work
      included). Deliberately left to the operator — see the section above.
- [ ] `pnpm install` so #688's `pnpm test:coverage` can run. Left undone on purpose: it mutates
      a shared checkout while a dev server is running.
- [ ] **Confirm #681 half B end-to-end on live data** — migration 0126 is applied on the live
      DB and the endpoint returns the field, but every row still reads `null` because no probe
      has run since. Check `failedSuites` on the newest base-health row after the next one.
- [ ] Nothing further open on #691 itself — this file + the CLAUDE.md rule + the two
      follow-up tickets (both now landed) are the complete fix.
