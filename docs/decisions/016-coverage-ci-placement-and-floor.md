# 016 — Coverage stays push-only, informational; no `--min` floor yet

Status: accepted (2026-08-25) · Ticket: #807 · Related: #797 (measurement), #765 (the
missing-report bug), #688 (original coverage wiring), #902 (follow-up: per-package
ratchet mechanism for a real floor)

## Problem

#797 landed a working repo-wide coverage measurement (71.87% lines / 61.34% branch /
63.47% functions; shared 76.37%, server 79.14%, mcp-server 48.85%, client 48.98%) but left
two things undecided: whether the `coverage` job in `.github/workflows/arch-gate.yml`
should run on `pull_request` (it currently runs only on `push`/`workflow_dispatch`), and
whether `coverage-report.mjs --min <pct>` should become an enforced floor.

## Measurement (this ticket)

The #797 baseline was timed on a loaded local dev box (~28m30s) and explicitly said that
was not evidence for a CI runner. This ticket pulled the actual CI numbers instead of
guessing, via `gh run list --workflow=arch-gate.yml` / `gh run view <id> --json jobs`
against this repo's own Actions history (dozens of runs/day from the fleet's push
cadence):

- Run `32813234278`: `coverage` job start→end 05:32:25→05:57:04 = **24m39s**, all four
  packages' `test:coverage` ran to completion (red — master carries failing tests from
  concurrent fleet work, unrelated to this ticket) and still emitted all 8 report
  artifacts (`reportOnFailure: true` doing its job).
- Run `32811555939`: the `coverage run` step itself failed after **15m34s** (05:07:29→
  05:23:03) — shorter only because a failure earlier in the four-package sequence cuts
  the run short; a clean pass is the ~25-minute figure above.

So: a GitHub-hosted runner is **not** meaningfully faster than the dev box for this
suite (~25 min either way) — it is CPU-bound test work (real git/node child processes,
#206/#680), not a machine-contention artifact. That answers the open question directly:
this is unambiguously too slow to add to every PR's critical path.

## Decision

1. **`coverage` stays off `pull_request`.** Keep the current `push` + `workflow_dispatch`
   triggers. Re-open this only if the suite itself gets meaningfully faster (sharding,
   dropping the real-child-process integration tests to a separate tier, etc.) — not by
   re-measuring the same suite on a different runner class.
2. **No `--min` floor yet.** A repo-wide floor would sit far above where mcp-server
   (48.85%) and client (48.98%) actually are — red on arrival, exactly the failure mode
   the ticket warned about. A floor pinned to each package's *current* number ratchets
   nothing by itself (see the `time-injection-spelling-ratchet` / `wire-dto-single-declaration`
   pattern this repo already uses for exactly this "don't regress, and don't let it sit
   flat forever" shape) — turning today's numbers into a real floor needs the same
   shrink/grow-tracked-and-tested mechanism, which is follow-up work, not a one-line
   `--min` add. Filed as **#902** rather than built here to avoid a snapshot floor
   nobody is on the hook to raise.

## Bug found while measuring, fixed here

Run `32811555939` showed `read the reports` and `merge the four lcovs` both **skipped**
(not run) when the preceding `coverage run` step failed — those two steps had no
`if: always()`, unlike the upload step below them. That means on a red suite (the common
case on this fleet-driven repo) the job uploads raw per-package artifacts but never
produces the merged, repo-anchored lcov `code-metrics` consumes — silently re-creating a
narrower version of the exact #765 problem (report technically exists, nothing reads it)
on every red push. Fixed by adding `if: always()` to both steps in `arch-gate.yml`.

## The other loose thread (#807's local no-report mystery) — still unexplained

Separate from the bug above: #807's own ticket text records one *local* run (26m29s, 12
failing files) that produced no report at all despite `reportOnFailure: true`, not
reproduced on a re-run or a deliberate single-file probe. The CI runs pulled here all
produced reports (once the `if: always()` fix above is applied), so this ticket did not
encounter that failure mode again. Left as recorded — re-run before concluding anything
from a future missing report.
