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

## Next steps
- [ ] #704 and #705 get worked (see BACKLOG.md once re-exported, or query the board directly)
- [ ] Nothing further open on #691 itself — this file + the CLAUDE.md rule + the two
      follow-up tickets are the complete fix.
