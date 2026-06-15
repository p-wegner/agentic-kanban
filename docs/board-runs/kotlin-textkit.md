# Board run: kotlin-textkit (Kotlin/Gradle library, hands-off)

**Date:** 2026-06-15
**Project:** kotlin-textkit (`C:\andrena\kotlin-textkit`), id `31f5f372-75ef-49ab-b865-629f9569a8fd`
**Stack:** Kotlin/JVM + Gradle 8.10 + JDK 21. Verify gate: `gradle test`.
**Result:** 12/12 children Done, all merged to master, `gradle test` green. Meta driven to Done.

## What was built
A library of 10 independent text utilities, each its own source + test file (zero shared hot
files — Gradle auto-discovers `*Test.kt`), plus an integration facade and a retro doc.

| # | Ticket | File(s) owned |
|---|---|---|
| 2 | Slugify | Slugify.kt |
| 3 | Word/char/line counter | WordCount.kt |
| 4 | Caesar cipher | Caesar.kt |
| 5 | Palindrome check | Palindrome.kt |
| 6 | Base64 encode/decode | Base64Util.kt |
| 7 | Levenshtein distance | Levenshtein.kt |
| 8 | Title case | TitleCase.kt |
| 9 | ROT13 / reverse | StringTransforms.kt |
| 10 | Roman numerals | RomanNumerals.kt |
| 11 | CSV line parser | CsvLine.kt |
| 12 | Integration: facade + README | TextKitFacade.kt, README.md |
| 13 | Retrospective | docs/RETRO.md |

## Parallelism
Fan-out epic: 10 independent leaves (no deps), #12 depends on all 10, #13 depends on #12.
WIP target 3 sustained; the leaf wave drained in ~10 minutes. Provider pinned per-project to
**claude / anth / sonnet** via `board_strategy_<id>` providerPolicies (mode:fill, model:sonnet);
every workspace verified `provider=claude, model=sonnet` (global default is codex — not used).

## Escalations / board gaps found (NOT hand-fixed in board internals)
1. **Meta auto-started as a builder.** `notDriveOrEpicMetaSql()` (#824) is applied only to the
   Backlog/Todo pull query, not the In-Progress backfill loop in `monitor-auto-start.ts`
   (lines ~153-198). The meta was created directly In Progress, so the backfill launched a stray
   builder on it. Remedy used = the supported `no-auto-start` tag (the code comment at line ~85
   says REST-seeded epics rely on it). Durable fix: apply `notDriveOrEpicMetaSql()` to the
   In-Progress backfill query too.
2. **REST `decompose/confirm` creates no first-class Drive record (#799),** so the #801
   `reconcileDriveCompletion` contract backstop never engaged. Completion contract was owned by the
   resident watch instead. Durable fix: have REST epic-seeding create a Drive, or expose Drive
   creation over REST. (Also: REST `POST /api/issues/batch` silently drops `dependencies`/
   `parentIssueId` — only `decompose/confirm` wires edges; the agentic-kanban MCP tools were not
   available in this session.)
3. **Auto-merge of an AUTO-STARTED workspace closes it WITHOUT stamping `workspaces.mergedAt`.**
   All 10 auto-started leaves ended `status=closed, mergedAt=None` though their work was on master.
   `computeBlockerReadiness` gates dependent start on `mergedAt`/`isDirect`, so the dependency-wave
   planner reported `readyButNotStarted: 0` and #12/#13 would have stalled permanently at 10/12.
   By contrast a workspace launched via `POST /api/workspaces` (manual path) DID get `mergedAt`
   stamped on merge — so #13 cascaded correctly once #12 was launched that way. Bug is in the
   auto-start→auto-merge landing path. Durable fix: stamp `mergedAt` when the auto-merge lands a
   branch (or let readiness also accept "blocker Done + base contains its merge").
4. **Stack detected as `java`, not `kotlin`.** Gradle build works for both, but the stack-profile
   rule-based detector labels a Kotlin/Gradle repo `java`. Cosmetic here; worth a kotlin rule.
