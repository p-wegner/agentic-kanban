# Domain-Docs Coverage Audit (standalone, Mode B)

> **RESOLVED (2026-06-26, HEAD `29e016dc`):** code-metrics was re-run on HEAD (1688 files);
> `issue-dependency.service.ts` + `issue-error.ts` were folded into `issues-board` (files 19→21)
> and the dependency-guard citations re-anchored to the new sub-service; `_plan.json`
> `analyzed_sha` → `29e016dc`. The two drift items below are fixed. Gate still PASS at
> blast-threshold 120. (The fresh churn window also surfaced a few more blast-100–120 fold-in
> candidates — phase-artifacts, session-paths, agent-launch-env — left for a follow-up pass.)

- **Run:** 2026-06-26 ~20:51 +0200
- **HEAD:** `ac7043a4`
- **Plan:** `docs/domain/_plan.json` (`analyzed_sha: 2cea8d3e` — STALE, see Drift §)
- **Analysis:** `code-metrics-out/analysis.json` (generated 2026-06-26 19:19 / `analysis_date 17:18 UTC`; reused, not re-run)
- **Tool:** `coverage.py --blast-threshold 120 --churn-top 40`
- **Scope declared in plan:** CORE DOMAIN — 13 capability modules; everything else explicitly deferred.

## Coverage summary

| Metric | Value |
|---|---|
| Source files (non-test) | 1020 |
| Mapped to a module | 187 (**18.3%**) |
| Unmapped | 833 |
| Important unmapped (blast≥120 / refactor_first / top-40 churn), not deferred | **0** |
| **COVERAGE GATE** | **PASS** (exit 0) |

Unmapped by package: client 327, server 318, mcp-server 76, root 58, shared 47, e2e 4, desktop 3.

`% mapped` is low by design (Louvain clusters by *package*, not capability; the plan documents 13 core contexts and defers the long tail). Per the playbook the bar is "no important file left unmapped-and-undecided," not a % target.

## Gate verdict: PASS — verified honest, with caveats

I did not rubber-stamp the 0. I recomputed the full IMPORTANT set independently: **163 important files; 71 owned by a module, 92 absorbed by the plan's `deferred` list.** Every one of the 92 is on the record. The blast≥120 absorbed files (the ones that could be a real miss) are all either an **individually-named** deferral or part of a **queued NEW MODULE**:

| blast | path | disposition (on record) |
|---|---|---|
| 294 | `server/src/errors/index.ts` | CROSS-CUTTING (README) |
| 260 | `server/src/repositories/issue-service.repository.ts` | FOLD-IN issues-board |
| 161 | `server/src/repositories/claude-cli.repository.ts` | FOLD-IN agent-providers |
| 160 | `server/src/services/claude-cli.service.ts` | FOLD-IN agent-providers |
| 155 | `server/src/services/workspace-merge-conflict.service.ts` | FOLD-IN workspaces/review-merge |
| 153 | `server/src/services/workspace-internals.ts` | FOLD-IN workspaces |
| 142–134 | `services/{gradle-detect,stack-detector,project-setup,stack-profile/*}`, `repositories/{project-setup,stack-profile}` (~12 files) | **NEW MODULE queued: stack-profile / project-registration / scaffold** |
| 136 | `server/src/lib/workspace-details-projection.ts` | FOLD-IN workspaces |
| 126 | `server/src/startup/transient-errors.ts` | NEW MODULE queued: server bootstrap |
| 124 | `server/src/lib/butler-loop-classify.ts` | FOLD-IN butler/agent-sessions |

Spot-checks (3 of the deferred entries are genuine code, not phantom rows): `services/stack-profile/` exists (6 files), `client/.../SettingsPanel.tsx` exists (churn 421, the #1 hottest file), `services/voice-capture.service.ts` exists. All confirmed.

### Caveat 1 — coarse deferral granularity (tool semantics)
`coverage.py:is_deferred` uses a **loose substring match** (`d.rstrip("/*") in p`), so directory-level deferred entries swallow whole trees. The widest buckets absorb many important files: `client/src/components` (17), `mcp-server/src/tools` (11), `services/stack-profile` (7), `server/src/cli/` (7), `services/workspace-` (6), `server/src/startup/` (4). The PASS is therefore only as honest as those bucket reasons. I inspected the absorbed set: the client-components and mcp-tools entries are genuinely peripheral (secondary panels, uniform-pattern tools — all low blast, high-churn-only) — acceptable long-tail. No high-blast capability is hiding inside a generic "LONG-TAIL" bucket.

### Caveat 2 — the one substantial undocumented capability (on record, but real)
The **stack-profile / project-registration / scaffold / stack-detection** capability (~12 important files, blast 134–142) — the turnkey multi-stack driver — has **no doc** yet. It is explicitly deferred as a queued NEW MODULE, so the gate is honest, but this is the single largest real coverage hole and should be the first Phase-2 follow-up. Likewise `client SettingsPanel` (NEW MODULE queued) and `server bootstrap/startup`.

## Cluster coverage (structure.md, 17 clusters)

Clusters are package-blobs (modularity 0.81 but auto-clustered by package); cohesive product clusters all map to ≥1 module:

| Cluster | Name | Files | Covered by |
|---|---|---|---|
| C1 | repositories (server) | 687 | issues-board, workspaces, agent-providers/sessions, monitor-orchestration, review-merge, butler, git-integration, preferences-config, persistence-schema |
| C2 | hooks (client) | 398 | board-ui, butler (client) + deferred long-tail |
| C3 | mcp-server | 115 | **mcp-server** |
| C4 | e2e | 93 | tests — out of universe (N/A) |
| C5 | shared | 58 | workflow-engine, git-integration, persistence-schema, agent-sessions |
| C6 | shared | 24 | shared libs (partial) + deferred long-tail |
| C7 | butlerchatparts (client) | 16 | **butler** |
| C8 | boardcolumn (client) | 16 | **board-ui** |
| C9 | agent-provider (server) | 15 | **agent-providers** |
| C10 | scripts (root) | 10 | ⚠ uncovered — root ops tooling (board-monitor loop etc.); peripheral, not deferred-by-name |
| C11 | skills (root) | 4 | ⚠ uncovered — agent-skill prompt files; non-code |
| C12 | hooks (root) | 3 | ⚠ uncovered — `.claude/hooks`; ops, low blast |
| C13–C17 | *.test clusters | 2 ea | tests — out of universe (N/A) |

All cohesive **product** clusters are covered. C10–C12 are root-level ops/config tooling (none important by blast); acceptable long-tail but **not** explicitly listed in `deferred` — minor record gap.

## DRIFT found

1. **Analysis predates HEAD by 5 commits.** `analysis.json` was generated 19:19 (17:18 UTC); commits up to `ac7043a4` land through 20:42 — including the doc-set commit `dc114218` and refactor `436d8dbc` (20:20). The audit is therefore against a code snapshot ~1.5h and 5 commits behind HEAD. The plan's `analyzed_sha: 2cea8d3e` is staler still (predates the docs themselves).
2. **New source file not in any module or deferral:** `packages/server/src/services/issue-dependency.service.ts` (313 lines, extracted from `issue.service.ts` in `436d8dbc`) and `issue-error.ts` (15 lines) exist on HEAD but are **absent from the fresh analysis** (it predates them) and **absent from `issues-board.files`**. `issue-dependency.service.ts` logically belongs to the documented `issues-board` module. Had the analysis been current it would surface as unmapped; depending on its blast it could flip the gate. **Action:** re-run `code-metrics`, add `issue-dependency.service.ts` (and `issue-error.ts`) to `issues-board.files`, re-run `coverage.py`.
3. **No module-file existence drift:** all paths listed in `_plan.json.modules[].files` still exist on disk (0 dangling).

## Bottom line

Gate **PASS** is honest at the blast≥120 line — every high-impact file is owned, folded-in to a documented module, or in a named queued NEW MODULE. Two things keep this from being a clean bill of health: (a) the **stack-profile/project-registration capability** is a real, sizable undocumented context (deferred, but the top Phase-2 target), and (b) **drift** — the analysis is 5 commits behind and a new 313-line `issue-dependency.service.ts` is unlisted. Refresh code-metrics and assign the two new files before treating the PASS as current-to-HEAD.
