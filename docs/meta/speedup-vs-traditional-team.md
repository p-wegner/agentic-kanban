# Speedup: Agent-Driven Solo Dev vs. Traditional Scrum Team

A snapshot evaluation comparing the actual time it took to build agentic-kanban
(solo, agent-driven) against an estimate for a traditional scrum team building
the same codebase.

Snapshot date: **2026-05-29**

## Codebase size

Measured with `scc` across all source packages (`ts`, `tsx`, `css`, `rs`).

| Package           | Files | Code   | Comments | Blanks | Total  |
| ----------------- | ----: | -----: | -------: | -----: | -----: |
| client/src        |    60 | 19,489 |      316 |  1,347 | 21,152 |
| server/src        |   171 | 23,702 |    1,397 |  3,357 | 28,456 |
| shared/src        |    29 |  2,776 |      313 |    322 |  3,411 |
| mcp-server/src    |    60 |  3,489 |      135 |    453 |  4,077 |
| e2e               |    59 |  9,552 |      872 |  1,960 | 12,384 |
| desktop/src-tauri |     3 |     52 |        1 |      5 |     58 |
| **Total**         |   382 | 59,060 |    3,034 |  7,444 | 69,538 |

- ~46k non-test code lines + ~9.5k E2E test lines.
- Server is ~40% of the code. E2E is ~16% of total — healthy test ratio.

## Actual elapsed time

From `git log`:

- **First commit:** 2026-05-01
- **Last commit (as of snapshot):** 2026-05-29
- **Elapsed:** 28 calendar days
- **Total commits:** 4,150
- **Authors:** 1 (Peter Wegner, solo)

### Commits per day

```
2026-05-01  |##                                                    16
2026-05-02  |###                                                   29
2026-05-03  |##                                                    23
2026-05-04  |#                                                      9
2026-05-07  |#                                                      3
2026-05-08  |#                                                      3
2026-05-10  |#                                                      2
2026-05-11  |#                                                      1
2026-05-12  |##                                                    13
2026-05-13  |#                                                      6
2026-05-14  |####                                                  33
2026-05-15  |####                                                  36
2026-05-16  |########                                              75
2026-05-17  |##########                                            97
2026-05-18  |######                                                52
2026-05-19  |##########################                           264
2026-05-20  |#################################################### 976
2026-05-21  |###################################################  656
2026-05-22  |#####################################                536
2026-05-23  |################################                     462
2026-05-24  |##########                                           122
2026-05-25  |###########                                          142
2026-05-26  |#############################                        405
2026-05-27  |##########                                           135
2026-05-28  |#####                                                 53
2026-05-29  |#                                                      1
```

Bar scale: `#` ≈ ~18 commits. Note the inflection on **2026-05-19**: this is
when the parallel agent-driven workflow (kanban board + concurrent worktrees)
came online. Pre-19th averaged ~17 commits/day; post-19th averaged ~375.

## Traditional scrum team estimate

Method: rough industry productivity heuristic (15–30 productive LOC per dev per
day, sustained, in a greenfield TS full-stack product), plus scrum overhead.

- 59k LOC ÷ (4 devs × 20 LOC/day) ≈ **740 dev-days** of capacity
- ≈ **~37 weeks** of pure dev capacity
- Plus discovery, design, integration, scrum ceremonies, rework
- **Realistic end-to-end: 6–12 months for a 4–5 person scrum team**

For comparison, `scc`'s COCOMO model (traditional, organic) estimates:

- ~17.75 months
- ~9.79 people
- ~$1.96M

COCOMO assumes traditional staffing and is generally pessimistic for a focused
team on a known domain — treat it as an upper bound.

## Speedup

| Metric                    | Solo agent-driven  | Scrum team (est.)         | Ratio       |
| ------------------------- | ------------------ | ------------------------- | ----------- |
| Calendar time             | 28 days (~4 weeks) | 6–12 months (26–52 weeks) | **~6–13×**  |
| People                    | 1                  | 4–5                       | **4–5×**    |
| Person-weeks              | ~4                 | ~120–250                  | **~30–60×** |

**Bottom line:** ~6–13× faster in calendar time, and ~30–60× less total
human effort — concentrated in a single person operating an agent fleet rather
than a coordinating team.

## Caveats

- LOC is a weak proxy for effort; complex 50-line algorithms can dwarf 500
  lines of CRUD. Treat these numbers as order-of-magnitude, not precise.
- Solo developer was *experienced* and had built related systems before — a
  novice with the same tooling would be slower.
- The codebase exists because the agent workflow worked here; survivorship
  bias applies. Failed attempts don't show up in `git log`.
- Scope was self-defined and iteratively refined. A scrum team building to a
  fixed spec might have less rework but more upfront design time.
- Commit count is inflated by the agent-driven workflow (many small commits
  per ticket). Commits/day is a useful *activity* signal, not a productivity
  metric.

## Reproducing this evaluation

```bash
# Code size
scc packages/client/src packages/server/src packages/shared/src \
    packages/mcp-server/src packages/e2e packages/desktop/src-tauri \
    --include-ext ts,tsx,css,rs --no-complexity

# Elapsed time + commits/day histogram
git log --reverse --format="%ai %an" | head -1
git log --format="%ai %an" | head -1
git rev-list --count HEAD
git log --format="%ad" --date=short | sort | uniq -c
```
