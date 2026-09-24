# The integration risk ladder

_How much a merge must prove, and where the rest of the proof happens, per risk posture.
The posture table in `packages/server/src/services/risk-posture.service.ts` is the source of
truth for the values; this page explains the ladder and the release-candidate model that
decision 019 puts under it. Read decision 017 for how one dial fans out, and
`docs/two-boards.md` §8 for the promotion mechanics._

## The idea in one paragraph

Every integration style answers the same three questions: **what does a merge prove**, **what
does the full suite prove and when**, and **who fixes red, where**. The ladder orders the
answers from "prove everything before landing" to "prove only your own change, prove the rest
on the release candidate". Higher rungs pay more per merge and never see a red base; lower
rungs pay per change and accept a red base, because the release, not the merge, is where green
is owed. The rung is a project setting (`risk_posture_<projectId>`), overridable per ticket
with a `risk:<level>` tag.

## The rungs

| Rung | Merge proves | Full suite runs | Red base | Review | Best for |
|---|---|---|---|---|---|
| **strict** | full suite, every merge | at every merge | blocks every merge | thorough, per ticket | client deliveries, a repo with no other safety net |
| **standard** | full suite, every merge | at every merge; master swept half-daily | blocks | standard, per ticket | the default; a repo that has not chosen |
| **fast** | scoped suite once per train (up to 8) | per train; master swept | allowed when it is known debt | the train, not the ticket | a sprint with a trusted crew |
| **sprint** | guards only, per train (up to 12) | never at merge; master swept | allowed, files a debt ticket | none | a throwaway or a spike |
| **iterate** | test-impact selection + the guard floor | nightly on master, misses recorded | allowed; files a heal ticket per failure signature, never holds the window (#1233) | standard, per ticket | a board that wants narrow gates but still a green master signal |
| **flow** (#1240) | typecheck + test-impact selection + the diff's own new tests; no guard floor | **on the release candidate only** | never blocks; reported and counted | standard, per ticket | the fastest honest cycle: this board's own development |

Two rules hold on every rung:

- **A weaker rung may only weaken verification visibly.** The posture's `summary` names what
  it skips, and the gate's pass message prices what ran (`selection kept 2 suites/~3s est,
  +12 guard suites`). A bare "passed" is never emitted.
- **A green selection is not a green suite.** The impact selection is a ranked guess. What it
  drops is measured by the miss-rate join (#1234): a suite that the release candidate finds red
  and no intervening merge gate ran is a miss, attributed to the merges that could have caused
  it. The number is what decides whether a rung may become a default.

## The release-candidate model (decision 019)

On `iterate` and `flow` the drawbridge is the release, and the release is a branch:

```
master  ──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──●──▶   (never waits)
            \                         \                 ↑
             rc/20260925 ──sweep──✓──▶ tag stable-…     │ merge-back (board workspace, normal gate)
                                       \                │
              rc/20260926 ─sweep─✗─heal─●─sweep─✓─▶ tag ┘
```

1. **Cut.** On the cadence (or `pnpm promote` by hand) the board cuts `rc/<date>` from master's
   tip. Master keeps merging; nothing on it waits for anything below.
2. **Sweep the candidate.** The base-branch sweep runs on the rc (a throwaway clone of the rc,
   the full `verify_script`, no scoping env; #1231 stamps the row with the mode it ran in). The
   rc is the only thing the sweep has to be green for.
3. **Green: promote.** The rc sha is tagged `stable-<date>` and deployed exactly as today
   (build, migrate, restart, smoke, rollback on failure). The rc is then merged back into master
   through the board, which is a no-op when nothing was healed.
4. **Red: heal on the candidate.** The board files one `heal` ticket per distinct failure
   signature, based on the rc branch and merging into it. The heal builder runs the same narrow
   gate as any builder plus the failing suites named in the ticket. When the rc goes green, step
   3 runs, and the merge-back carries the fix to master. A candidate red for more than one
   cadence is abandoned; the next cut carries the open heal ticket forward.
5. **Regular cadence keeps the red small.** With a daily cut, any red suite is at most a day of
   landings old, and the heal ticket names those landings. Skipping releases is how red
   accumulates; the cadence is the control, not the gate width.

What this buys: the stable board only ever runs a sha that passed the full suite, and no
merge ever waits for that suite. What it costs: two branches can be red at once (master and
the rc), and the heal work is real work that the cadence makes visible instead of deferring.

## What a builder does on the low rungs

- Work in your worktree on your branch, against whatever master was when you branched.
- Run the impact selection, not the package suite: `node .claude/skills/test-impact/tools/
  impact.mjs select --min-score 1.0 --format vitest`, then what it prints, plus your own new
  tests. Make those pass. That is your gate.
- Mark ready. The board's merge gate re-runs the same selection on the merged tree plus
  typecheck, and lands the branch. A red suite you did not touch is a finding for the heal
  ticket, not your task. Do not widen your run to prove master.
- Never move the base branch, never rebase onto a remote ref, never fix master from a
  worktree. The guard from #1237 blocks the first two; the third is what heal tickets are for.

## What the operator watches

- The delivery view (and `pnpm cli -- tracker`): master's last verdict, the rc's verdict, the
  inherited-red count, the open heal tickets, and the impact miss rate.
- `pnpm promote --dry-run`: which rc, which sweep row, its scope, and the ledger evidence
  since the last green (labelled as the weaker measurement it is).
- The Sentinel's one line names the rc state when a cadence is configured.

## Where each piece lives, and what is still a ticket

| Piece | Status |
|---|---|
| Posture dial and the five existing rungs | landed, decision 017 |
| Guard-floor deferral under `iterate` / `flow` | landed, #1232 — `guards_at_merge_<id>` / `KANBAN_TEST_GUARDS=intersecting`; every bare marker now carries a reviewed `when:` or `always` spelling |
| Posture-aware red-base veto, heal ticket under `iterate` | landed, #1233 |
| Miss-rate join and gate durations in the ledger | landed, #1234 — `.test-impact/misses.jsonl`, `impactMissRate` on delivery + tracker, the `miss rate` line in `promote --dry-run` |
| Sweep env scrub and scope stamp; `promote` refuses a non-full green | #1231 |
| Deterministic guard failures stop the re-gate loop | #1230 |
| RC branch promotion and the cadence | #1238 |
| Heal-on-candidate and the merge-back | #1239 |
| The `flow` posture | #1240 |

A ratchet keeps this table honest: `integration-risk-ladder-doc.test.ts` (part of #1240)
fails when a posture level exists in the resolver and not in the rungs table above, or the
other way round.
