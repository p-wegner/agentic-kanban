# Decision 019: Promotion gates a release candidate, never master

## Date: 2026-09-24

## Context

Decision 017 gave every project one risk-posture dial, and `docs/two-boards.md` §8 made
promotion the one moment the full suite decides anything ("Yegge's drawbridge"). Both stop
short of saying what happens to master while that moment lasts. Today:

- `pnpm promote` reads the last `base_branch_health` row for **master** and refuses anything
  but a fresh green. The sweep is a throwaway clone of master's tip, 25-35 min measured.
- While the sweep runs, master keeps moving (every landing changes the sha), so the row the
  promotion needs is stale the moment a train lands. `--recover` and `--force-sweep` are the
  escape hatches, and #1044 records how each forced run made the next honest one impossible.
- A red sweep on master blocks the train window under every posture whose `redBasePolicy` is
  `block` (`merge-train-base-veto.ts`), and master only moves through trains. Measured
  2026-09-24: the dev board froze on exactly this, and only a hand fix on master reopened it.
- The per-merge gate under `iterate` is the test-impact selection, but it still pays the
  unconditional `@gate:always-run` floor (171 guards, ~585 s) on every merge, so "narrow"
  is not what a merge actually costs (#1232).

The workflow we want, stated once: **a builder proves only its own change; master may be red;
the full suite runs on a candidate that master does not wait for; a red candidate is fixed on
the candidate; every release is green; regular releases keep the red small.** The gate that
ensures working software moves to the last possible point in time.

## Decision

1. **Promotion cuts a release-candidate branch and gates THAT.** `pnpm promote` creates
   `rc/<YYYYMMDD>[-N]` from master's tip, and the base-branch sweep runs against the rc branch
   (`base_branch_health.branch = rc/...`). Master keeps merging throughout. When the rc sweep is
   green the rc sha is tagged `stable-<date>` and deployed exactly as today (build, migrate,
   restart, smoke, rollback). Nothing about the stable checkout changes; only what it is pointed
   at is now an rc, never a moving master. (#1238)

2. **A red candidate is fixed forward on the candidate, by the board.** A red rc sweep files a
   `heal` ticket whose workspace is based on the rc branch and merges into it (`workspaces.
   baseBranch = rc/...`, the merge target follows). The heal builder runs the same narrow gate as
   any builder: typecheck, impact selection, the failing suites named in the ticket. When the rc
   sweep goes green, the rc is promoted, and the rc is merged back into master through the board
   (a merge-back workspace, gate as usual), so the fix reaches master without anyone hand-landing
   a branch. A candidate that stays red for longer than a cadence is abandoned, and the next
   cadence cuts a fresh one from master, carrying the heal ticket along. (#1239)

3. **The highest-risk-tolerant posture is a level, not a pile of overrides.** A new posture
   `flow` sits below `iterate` on the ladder: per-merge gate = typecheck + impact selection +
   the diff's own new test files, no unconditional guard floor at merge time, no red-base veto
   on the train window, per-ticket review as `standard`, and the ONLY full-suite run is the rc
   sweep. `iterate` keeps its nightly master sweep as an information signal; `flow` treats the
   rc as the only place a full verdict is owed. The visibility rule from decision 017 holds:
   `summary` names everything skipped, and the gate message prices what ran. (#1240)

4. **Promotion is scheduled, not remembered.** A per-project cadence (`promote_cadence_<id>`,
   default off; the dev board sets daily) cuts and drives an rc without an operator, and the
   Sentinel reports the rc state in its one line. Regular releases are what keep the red small:
   a red suite is at most one cadence old, and the heal ticket names the merges that landed since
   the last green (the miss-rate join, #1234). (part of #1238)

5. **Master's health is a report, never a lock.** `resolveBaseRedVeto` becomes posture-aware
   (#1233): under `iterate` and `flow` a red master holds nothing; the control arm that stops a
   bisect from blaming a member for master's own red stays under every posture. The delivery
   view shows master's last verdict, the rc's verdict, and the count of red suites the rc
   inherited, so "how red is master right now" is a number rather than a feeling.

## Consequences

- The stable board always runs a sha that passed the full suite. That was the promise before;
  now it is true without stopping master to keep it.
- A merge under `flow` costs what the change touched. Measured today under `iterate`: arch
  43 s + typecheck 19 s + tests 118 s for a 3-file client change, of which the selection was
  ~2 files. #1232 is the ticket that removes the floor; #1234 is the one that measures what the
  floor was catching.
- Two branches can be red at once (master and an rc). That is the design: the rc's red is
  being healed, master's red is being measured. What must never happen is an rc that is green
  by accident: #1231 stamps every sweep row with the mode it ran in, and `promote` refuses a
  green whose scope is not `full`.
- A heal ticket is ordinary board work. It is started by the monitor within WIP, runs under
  the roster and the auth ring, and closes when the rc is green. No new agent role.
- The ladder is documented once, in `docs/integration-risk-ladder.md`, with the posture table
  as the source of truth (`risk-posture.service.ts`). A posture change that is not reflected
  there fails the ratchet that document declares.

## Rejected

- **Gate master harder instead** (make `standard` the dev board's posture). Rejected: the
  measured floor is ~10 min per merge before the selection runs, and a red master still froze
  the window. It buys a green master at the price of the throughput this board exists for.
- **Promote master's tip with `--force-sweep` and heal in place.** Rejected: that is what
  #1044 measured, and each forced run made the next honest one impossible.
- **Fix a red rc on master and re-cut.** Rejected: the fix then rides with every unrelated
  landing since the cut, so the second rc is a different tree and the sweep starts over. Fixing
  on the rc keeps the candidate's delta exactly the fix.
- **A separate "release" agent role.** Rejected: a heal ticket is a builder ticket with a
  different base branch; the roles table in CLAUDE.md does not grow for it.
