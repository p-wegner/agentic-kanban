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

- **#681 half B** — "alarm on an `@gate:always-run` suite red for more than one cycle" is
  NOT implemented, and #681 is left open with a comment recording exactly this. Half A
  (degenerate distribution, N probes 0 green) landed earlier in `8e42105e27`. Half B needs
  per-suite outcome persistence across probes — a real feature, not a follow-on edit. A
  base-health *streak* alarm was considered as a cheap substitute and rejected: it alarms on
  a different thing and would let the ticket close without the per-suite attribution that is
  its whole point.
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

## Next steps
- [x] Full suite verified green at `0ad6497aec` (all four packages)
- [ ] Decide whether to push master (56+ commits ahead of origin, other agents' work included)
- [ ] `pnpm install` so #688's `pnpm test:coverage` can run
- [ ] #681 half B — the guard-suite-rot alarm (see the ticket comment for the design)
- [ ] #700 looks stale — verify and close (`exit-workflow.ts` is 967 lines, gate exits 0)
- [ ] #704 and #705 get worked (see BACKLOG.md once re-exported, or query the board directly)
- [ ] Nothing further open on #691 itself — this file + the CLAUDE.md rule + the two
      follow-up tickets are the complete fix.
