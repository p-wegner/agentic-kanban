---
repo: agentic-kanban
analyzed_sha: 29e016dc
verdict: "PARTIAL — the central agentic loop's requirements are well covered; gaps were in the UI surface (deferred-with-module) and a set of genuine blind spots now remediated."
method: 4 independent requirement sources mined adversarially (PRD, decision records, the test suite, CLAUDE.md + error catalog)
---

# Requirements-coverage verification (Phase 4c)

A third review axis, distinct from the others:
- **Phase 4a coverage** asks: does every important *file* map to a module?
- **Phase 4b per-module review** asks: is each doc *accurate* about its code?
- **Phase 4c (this)** asks: **does the doc set capture all the important *requirements* the system implements?** — verified against sources *independent of the docs*, assuming each requirement is undocumented until the covering passage is found.

## Sources mined (independent of docs/domain)
| Source | What it encodes | Result |
|--------|-----------------|--------|
| `docs/prd/` (features-catalog, MVP scope, exec summary) | product requirements / features | 27 covered, 5 partial, 15 missing (mostly UI surface) |
| `docs/decisions/` (10 ADRs) | durable architectural requirements | 6 covered, 3 partial, **1 fully missing (009 dep-pinning)** |
| the test suite (1666 files; ~26 sampled) | executable edge-case invariants | 17 covered, 5 partial, **3 missing service mechanisms** |
| `CLAUDE.md` hard constraints + `errors/index.ts` | system safety invariants + failure-mode contract | 12 covered, 6 partial, **5 missing** |

## Verdict
**No, the first cut did not cover all important requirements** — but the misses fall into two clean classes, both now resolved or recorded:

### Class 1 — genuine blind spots in *documented* modules → FIXED this pass
These were requirements the modules *should* have stated and didn't (accurate-but-incomplete docs). Each was verified against code/tests and folded into the owning doc:

| Requirement | Source | Now documented in |
|-------------|--------|-------------------|
| Decision **009 dependency-pinning by blast radius** (exact-pin correctness-core + transport/IPC; `dependency-pinning.test.ts`; `engines.node`) | ADR 009 | README cross-cutting |
| **Typed-error contract** (`AppError` + NotFound/Validation/Conflict/Forbidden + `AiOperationError` AI_ERROR/500; central mapping, no hand-rolled `message.includes`) | errors/index.ts | README cross-cutting |
| **Process crash-resilience** (uncaught/unhandled caught-and-logged; agent-callback try/catch; port-conflict `[fatal]` exit) | CLAUDE.md / process-handlers.ts | README cross-cutting |
| **Dependency auto-chain** (3rd auto-start path: single-candidate, WIP, no-auto-start skip, cycle exclusion, audit comment, `dependency_auto_chain` pref, manual-mode no-cascade lock) | dependency-auto-chain.test.ts | monitor-orchestration |
| **Dependency-wave planner** (ready/blocked/cyclicInvalid, WIP-fit waves, `planMode:false` #767, fan-in blocks until all land) | dependency-wave.service.test.ts | monitor-orchestration |
| **Zombie fix/review-session reconciler** (no-PID + 0-msg + past-grace; skip guards; pref) | zombie-fix-session-reconciler.test.ts | review-merge |
| **#629 zero-commit readyForMerge guard** (empty branch never approved/broadcast) | ready-for-merge-zero-commit-guard.test.ts | review-merge |
| **#583 already-merged reconcile-no-op contract** (`{merged:false,reconciled:true}`, Done, no new commit; 0-commit must NOT reconcile) | merge-endpoint-reconcile-noop.test.ts | review-merge |
| **Ancestor-branch reconciler guards** (#581/#585: never reap active/fresh-0-commit) | ancestor-branch-reconciler.test.ts | review-merge |
| **createIssue node-alignment** (currentNodeId set only if created status maps to a node; cross-project template rejected) | issue-create-workflow-status.test.ts | workflow-engine |
| **`reset --soft` in a worktree corrupts `.git`** (distinct from the `--hard` guard) | CLAUDE.md | git-integration |
| **`diff_comments` table** (inline review comments — the data half of the diff-review UI) | schema/diff-comments.ts | persistence-schema |
| **DB-mutation operating rule** (records via MCP/API only; `validate-command-safety` PreToolUse hard gate) | CLAUDE.md | persistence-schema |
| **Agent-role vocabulary** (Steward = the docs' "Monitor Butler"; Sentinel; Smith — reconciled with CLAUDE.md's 7-role table) | CLAUDE.md | glossary |

### Class 2 — UI-surface requirements → DEFERRED with their queued module (on the record)
These are real DONE product features, but they belong to capability modules already declared out-of-scope for this core-domain pass (`_coverage.md` queued modules). They are deferred *with a named owner*, not blind spots:

| Requirement(s) | Queued module that will own them |
|----------------|----------------------------------|
| Diff viewer (unified/split, file tree) + inline diff-comments UI | board-ui / a `diff-review-ui` module (the `diff_comments` *table* is now in persistence-schema) |
| Analytical views: Metrics, Insights/Agent-Performance, Timeline/Gantt, Standup Digest, Swimlane-matrix | board-ui / `analytics-views` |
| Settings panel (tabbed), command palette (Ctrl+K), keyboard shortcuts, dark/light theme | client app-shell |
| Flaky-Tests Radar + ingestion API, PR Quality Score badge, Scheduled recurring runs, Voice Inbox | analytics / scheduling long-tail (deferred in `_coverage.md`) |
| Desktop app (Tauri v2, system tray, OS notifications) | `packages/desktop` (deferred non-product-domain) |
| AI ticket utilities (Enhance / Decompose / AI-estimate / Predict-files) | issues-board (fold-in: `issue-ai.service`, queued) |

### Class 3 — rationale/partial gaps (noted, low priority)
Architectural *outcomes* are documented but some *binding rationale* is thin: ADR 006 (disposable-process tradeoff + bounded `state.md`), ADR 007 (Pi hook reuse-not-fork + degraded Stop-hook), ADR 004 (spec-planning interactivity/opt-in/Constitution-alignment — partly unbuilt). Captured here rather than expanded inline.

## Remaining recommendation
The Class-2 UI requirements are the largest outstanding body. Documenting the **client app-shell** + **diff-review-ui** + **analytics-views** modules (Phase-2 fan-out) would take requirements coverage from "central loop complete" to "product complete". Tracked in `_coverage.md`.
