# Decision 021: Code-health posture — soft and hard caps per metric; soft breaches accumulate into a cleanup ticket

## Date: 2026-10-18

## Context
The flat 1000-line god-module ceiling (and the static ratchets: branches per function, top-level
declarations per file) was enforced first at the train, so every builder learned it after the fact.
Measured (#1613): 35 commits in 30 days existed only to get back under a ceiling, 21 source files
sat at >= 950 lines (3 at exactly 1000 — the ceiling became a floor), and trains 2026-10-18-05..07
stalled ~2 h on one breach. Code health is a concern to handle regularly, in batches, not on every
change. Decision 017 already gave delivery speed a posture dial; code health gets the same shape.

## Decision
Each metric gets TWO caps (one table, `packages/shared/src/lib/code-health-caps.json`, read by
`scripts/check-god-modules.mjs`, `max-file-size.test.ts` and `server/src/lib/code-health.ts`):

- **soft** — a breach never blocks. It is recorded in the code-health ledger
  (`code_health_ledger_<id>`: file, metric, value, cap, first-seen, crossing commit/ticket) and shown
  as `code health: 7 soft breaches in 4 files, cleanup ticket at 10 (relaxed)`.
- **hard** — a breach blocks, only where the author still has the context: the builder's pre-commit
  hook and implement-exit check (#1603, #1604). The train only re-checks hard caps. The ratchet
  baselines (`COMPLEXITY_BASELINE`, `COHESION_BASELINE`) are the hard-cap grandfather list: a
  baselined file's hard cap is raised to its baseline.

`code_health_posture_<id>` ∈ `strict | balanced | relaxed`; the default derives from the risk posture
(strict→strict, standard/iterate→balanced, fast/sprint/flow→relaxed) and a per-project value overrides.

| Level | Lines soft / hard | Branches soft / hard | Declarations soft / hard | Cleanup ticket when |
|---|---|---|---|---|
| `strict` | 800 / 1000 | 20 / 25 | 15 / 20 | any soft breach |
| `balanced` | 1000 / 1300 | 25 / 35 | 20 / 25 | 5 breaches or 7 days |
| `relaxed` | 1000 / 1600 | 25 / 45 | 20 / 30 | 10 breaches or 14 days |

**Accumulation creates the work.** `recordCodeHealth` (`services/code-health.service.ts`) folds each
scan into the ledger (an entry keeps its first-seen while it still breaches; fixed ones drop out).
When the trigger fires it files ONE consolidated ticket (`external_key` `code-health-cleanup:<id>`);
later breaches APPEND to it while it is not started; once it starts, new breaches accumulate for the
next ticket (one open cleanup ticket at a time).

`GET /api/projects/:id/delivery` carries `codeHealth` (resolved level, caps, trigger, open count) next
to the risk posture. `POST /api/projects/:id/code-health/report` records a scan
(`node scripts/check-god-modules.mjs --report out.json` produces the body's `softBreaches`).

**The hard cap is the trigger, the soft cap is the target.** A hard-cap breach is fixed only by
bringing the file/function below its SOFT cap (`1520 lines > hard cap 1600`-style messages state the
soft cap and the lines to remove), so each firing buys a full soft cap's worth of headroom; squeezing
under the hard cap does not pass. The consolidated cleanup ticket's acceptance is the same: every
listed file/function below its soft cap, decomposed behind the existing import path.

## Consequences
- The gate script's default level is the table's `gateDefaultLevel` (`relaxed`); `--level` or
  `KANBAN_CODE_HEALTH_LEVEL` overrides it. At adoption the tree has soft breaches (the first batch is #1605).
- #1603/#1604 enforce only HARD caps; #1606 shows headroom against the soft cap.
- The cleanup ticket is an ordinary ticket (operator, 2026-10-19): default backlog placement, no
  queue jump, no separate "run alone at a quiet moment" scheduling; the board pulls it in like any
  other. This replaces the proposal's run-alone idea.
- Wired (#1619): `startup/code-health-scan-reconciler.ts` observes each project's base-branch tip every
  5 min. A tip not yet scanned (train, single merge or operator hand-merge alike) runs
  `check-god-modules.mjs --report` on a host verify slot and records the result with `ref` = the sha;
  the last scanned sha lives in `code_health_scan_<id>`, so a re-observed landing is not re-counted. A
  failed scan logs one `[code-health-scan]` line and retries next tick; a project with no landings is
  re-scanned daily so the "N days" trigger fires. `status --watch` shows the ledger line under BASE & RELEASE.
- Numbers are the proposal's; change them in the JSON only, with this record.
