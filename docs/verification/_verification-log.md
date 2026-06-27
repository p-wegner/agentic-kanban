# Verification model — run ledger

Shared dedup anchor across discover → cover → author runs. Each entry: what ran, on what scope,
what it found, what's still open. The model in this directory is **incremental** — a re-run
updates changed capabilities, it does not rebuild from scratch.

---

## 2026-06-27 — pipeline dry-run (slice: `workspaces` only)

**Scope: 1 of 15 capabilities.** This is a validation slice, not a full model. The other 14
capabilities in `docs/domain/_plan.json` are NOT YET in `_behavior-model.json` / `_coverage.json`.

- **behavior-discovery** (skill validated): produced the `workspaces` capability record — 26
  observable behaviours, 14 entry points, 5 actors, an 11-state lifecycle (14 transitions), 13
  error states, 6 explicit unknowns. Confidence 21 high / 5 medium / 0 low. Live-confirmed the
  unscoped-list 400 read-only against the running server.
- **coverage-intelligence** (skill validated): mapped behaviours against the existing suite —
  19 covered / 2 partial / 5 uncovered; capability score 0.76. Weakest dimensions:
  `state-transition` (4 uncovered) and `error` (3 uncovered) — as predicted. `permission` = N/A
  (single-user/local). Produced `_coverage.json`, `_gaps.md`, `_priorities.md` (8 ROI-ranked
  gap specs through P4).
- **e2e-test-author**: NOT run in the dry-run. The `_priorities.md` backlog is its work order.

### Finding folded back into the skill (this run improved the tooling)
The deterministic candidate filter used during the dry-run matched tests by **slug keyword**
only, so source-importing unit tests (`merge-cascade.test.ts`, `auto-start-followup-setting.test.ts`,
`agent.service.test.ts`) were excluded — making genuine coverage look like gaps. Fixed:
`tools/test-inventory.mjs` now emits `imports`/`import_basenames`; `coverage-intelligence`
Phase 1 + `mapping-brief.md` now build the candidate set as the **union of api-path / route /
source-import** matches. Re-verified: workspaces candidate set 12 → 29 files. The 3 high-value
`uncovered` rows in `_coverage.json` (cascade, plan-gate, reattach) are therefore **suspect** —
a non-dry re-run with the source-matched set may downgrade them to dimension top-ups. Their
`_priorities.md` rows already carry a "verify out-of-candidate tests first" note.

### Still open
- Run discovery + coverage for the remaining 14 capabilities (fan-out, per the skills).
- Re-map `workspaces` with the source-matched candidate set; reconcile the 3 suspect uncovereds.
- Phase 2 requirements-mapping (PRD/ADR/constraint → behaviour) not yet run — `documented-missing`
  / `undocumented-implemented` buckets are empty only because that pass hasn't happened.
