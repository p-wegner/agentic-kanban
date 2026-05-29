# Evolution: Coding-Aider (2024) vs. Agentic-Kanban (2026)

Two solo-built, dogfooded AI coding tools, ~14 months apart. Same builder,
same style of project (build the AI tool with the AI tool), but very different
tooling generations. This doc compares them side-by-side as a snapshot of how
much the agentic-coding stack changed in a year.

Companion to [`speedup-vs-traditional-team.md`](./speedup-vs-traditional-team.md).

Snapshot date: **2026-05-29**

## The two projects

| Aspect            | Coding-Aider                                | Agentic-Kanban                           |
| ----------------- | ------------------------------------------- | ---------------------------------------- |
| Repo              | `C:/andrena/jetbrainsplugins/aider-shortcut` | `C:/andrena/agentic-kanban`              |
| What it is        | JetBrains IDE plugin wrapping the `aider` CLI | Local kanban board for AI-driven coding tasks |
| Stack             | Kotlin (IntelliJ Platform SDK)              | TypeScript (Hono + React + Drizzle + MCP + Tauri) |
| Era               | 2024-09 → 2025-10                           | 2026-05                                  |
| AI tooling used   | `aider` CLI + GPT-4-class models            | Claude Code (Opus 4.x) + parallel agent fleet |
| Self-verification | Limited; manual UI checks in IntelliJ       | Playwright E2E from day one + visual verification skill |
| Parallelism       | Single conversation at a time               | Kanban board with N concurrent worktrees + agents |

Both are **dogfooded**: the tool helped build itself. The difference is
*how much* of the work the tool actually drove.

## Codebase size

Measured with `scc`.

### Coding-Aider

| Area              | Files | Code   | Comments | Blanks | Total  |
| ----------------- | ----: | -----: | -------: | -----: | -----: |
| src/main (Kotlin) |   183 | 20,911 |    1,438 |  3,234 | 25,583 |
| src/test (Kotlin) |    18 |  2,188 |      207 |    381 |  2,776 |
| Other (docs/XML/JS) |   46 |  4,013 |      119 |    868 |  5,000 |
| **Total**         |   247 | 27,112 |    1,764 |  4,483 | 33,359 |

- ~23k Kotlin productive lines (main + test).
- **Test ratio: ~10%** (2.2k test / 20.9k main).

### Agentic-Kanban

| Area              | Files | Code   | Comments | Blanks | Total  |
| ----------------- | ----: | -----: | -------: | -----: | -----: |
| Source (client/server/shared/mcp/desktop) |   323 | 49,508 |    2,162 |  5,484 | 57,154 |
| e2e (Playwright)  |    59 |  9,552 |      872 |  1,960 | 12,384 |
| **Total**         |   382 | 59,060 |    3,034 |  7,444 | 69,538 |

- ~46k non-test code lines + ~9.5k E2E test lines.
- **Test ratio: ~19%** (E2E only; doesn't count unit tests inside `src/`).

## Elapsed time and activity

### Coding-Aider

- **First commit:** 2024-09-04
- **Last commit:** 2025-10-19
- **Elapsed:** ~411 calendar days (~14 months)
- **Active commit days:** 181 (~44% of calendar days)
- **Total commits:** 3,348
- **Authors:** Peter (solo); **~55% of commits are co-authored `(aider)`** — i.e. the tool itself drove just over half the commits.

Commits per month:

```
2024-09  |##########################################  865
2024-10  |######                                      125
2024-11  |############################################ 890
2024-12  |##############                              281
2025-01  |##########                                  205
2025-02  |############                                233
2025-03  |##                                           38
2025-04  |#########                                   188
2025-05  |##########                                  210
2025-06  |#                                            22
2025-07  |##########                                  211
2025-08  |##                                           50
2025-09  |#                                            12
2025-10  |#                                            18
```

Bar scale: `#` ≈ ~20 commits. Note the spiky cadence — heavy bursts (Sep/Nov 2024,
Jul 2025) separated by quiet months. Each burst is roughly one focused
"sprint" of attention; in between, the project sat. Total **active days = 181**,
so the *effective* working time is closer to 6 months than 14.

### Agentic-Kanban

- **First commit:** 2026-05-01
- **Last commit:** 2026-05-29
- **Elapsed:** 28 calendar days
- **Active commit days:** ~25 (nearly every day)
- **Total commits:** 4,150
- **Authors:** Peter (solo). Co-author tags vary, but the working model is
  "agent fleet drives most commits; human steers via kanban board."

See [`speedup-vs-traditional-team.md`](./speedup-vs-traditional-team.md) for
the day-by-day histogram. Key inflection: **2026-05-19**, when the parallel
agent + kanban workflow came fully online and daily commits jumped from ~17
to ~375.

## Throughput comparison

| Metric                              | Coding-Aider | Agentic-Kanban | Ratio (AK / CA) |
| ----------------------------------- | -----------: | -------------: | --------------: |
| Productive code (LOC)               |       27,112 |         59,060 |          **2.2×** |
| Calendar days elapsed               |          411 |             28 |          **0.07×** |
| Active commit days                  |          181 |            ~25 |          **0.14×** |
| Commits                             |        3,348 |          4,150 |          **1.2×** |
| LOC / calendar day                  |           66 |          2,109 |         **~32×** |
| LOC / active day                    |          150 |          2,362 |         **~16×** |
| LOC / commit                        |          8.1 |           14.2 |          **1.8×** |
| Test ratio (test LOC / main LOC)    |          ~10% |           ~19% |             ~2× |

**Headline:** ~2× more code, in ~7% of the calendar time, with ~2× the test
density. Per active working day, the agentic-kanban-era workflow produced
roughly **~16× more productive code** than the aider-era one.

## What actually changed in the year between them

A few specific things were the difference, not just "models got better":

1. **From conversational to fleet-driven.**
   Coding-Aider was driven through one aider chat at a time. Agentic-kanban
   spawns N concurrent worktrees, each with its own agent on its own ticket;
   the human reviews and merges, not types.

2. **From "I'll test it manually" to self-verification.**
   Coding-Aider had Kotlin unit tests but limited end-to-end coverage of the
   plugin's IDE behavior — manual IntelliJ runs filled the gap. Agentic-kanban
   has Playwright E2E + a "visual verification" skill the agent runs itself
   before claiming done. Feedback loop closed without the human in it.

3. **From "hope it compiles" to enforced gates.**
   Hooks block destructive DB ops, commit-on-fail-tests, etc. The harness
   itself prevents whole classes of agent mistakes that used to require
   human cleanup.

4. **From GPT-4-class to Claude Opus 4.x.**
   The model itself is meaningfully more capable at long-horizon tasks and
   tool use — fewer micro-corrections needed per ticket. But this is probably
   the *smallest* factor: most of the speedup is workflow, not raw model
   capability.

5. **From single-tool to MCP + skills.**
   Agentic-kanban is built around MCP tools and Claude Code skills that
   codify project-specific workflows. The agent has a vocabulary; the
   aider-era agent had a chat box.

## Caveats

- **Different problem domains.** A JetBrains plugin is constrained by the
  IntelliJ Platform SDK and KTS build system, which has high friction per
  change. A TypeScript web app has much faster iteration cycles. Some of the
  speedup is "JVM/IDE plugin → TS web app", not "old AI → new AI".
- **Coding-aider's calendar days include real idle months**, not just slow
  ones. Comparing on *active* days is fairer but still imperfect.
- **LOC is a weak proxy.** A line of plugin glue ≠ a line of React component
  ≠ a line of E2E test. Treat ratios as order-of-magnitude.
- **Survivorship bias.** Both projects exist and were finished/finishing.
  Many agentic experiments at both points in time died quietly.
- **Co-author tag noise.** The `(aider)` co-author tag is a signal that aider
  *wrote* commits, but solo human commits often included substantial AI help
  that didn't get tagged. So the "55% AI-driven" number for coding-aider is
  a lower bound.

## Why this matters for a talk

The comparison shows that the leap from "AI-assisted coding" (2024) to
"agent-driven engineering" (2026) isn't mostly about the model. It's about:

- **Concurrency** (one chat → many agents on the board)
- **Self-verification** (human eyeballs → Playwright + skills)
- **Guardrails** (trust the agent → trust the harness around the agent)
- **Workflow as code** (chat history → MCP tools + skills + kanban)

The same person, working in the same style, on the same kind of project,
shipped ~2× the code in ~7% of the calendar time — and spent that time
reviewing and steering rather than typing.

## Reproducing this evaluation

```bash
# Coding-Aider
scc C:/andrena/jetbrainsplugins/aider-shortcut/src --no-complexity
cd C:/andrena/jetbrainsplugins/aider-shortcut
git log --reverse --format="%ai" | head -1
git log --format="%ai" | head -1
git rev-list --count HEAD
git log --format="%ad" --date=format:"%Y-%m" | sort | uniq -c
git log --format="%ad" --date=short | sort -u | wc -l   # active days
git shortlog -sn HEAD

# Agentic-Kanban
# (see speedup-vs-traditional-team.md)
```
