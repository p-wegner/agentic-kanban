# Coverage matrix — functional coverage by capability

Generated from `_coverage.json` (`render.mjs`). **NOT line coverage** — a behaviour is
"covered" only when a test asserts its observable outcome across its risk-relevant dimensions.

**Overall: 0.868 — 221 covered · 32 partial · 20 uncovered across 273 behaviours in 15 capabilities.**

| Capability | Score | Covered | Partial | Uncovered | Weakest dimensions |
|---|--:|--:|--:|--:|---|
| mcp-server | 0.78 | 14 | 3 | 3 | permission, workflow, concurrency, config(security egress) |
| board-ui | 0.80 | 19 | 3 | 3 | error-handling, concurrency, state-transition (negative/rejected edges), accessibility (keyboard-nav operability) |
| workspaces | 0.81 | 20 | 2 | 4 | state-transition, error |
| project-registration | 0.82 | 13 | 2 | 2 | workflow, error-handling, state-transition |
| agent-sessions | 0.82 | 14 | 5 | 1 | concurrency (reattach/exit-race, buffer-free, FK-race all partial/untested), regression (resume chain + restart survival unverified), workflow (provider-resume relaunch + multi-turn follow-up end-to-end gaps) |
| monitor-orchestration | 0.83 | 15 | 0 | 3 | state-transition (conductor lifecycle + re-entrancy guard untested), observability (butler logging untested), navigation (wave/contract UI surfacing not e2e-asserted) |
| codemods | 0.83 | 7 | 1 | 1 | capability, config, boundary |
| review-merge | 0.86 | 15 | 3 | 0 | workflow (reconciler-relaunch + sync-merge land paths unasserted), api (fix-and-merge endpoint + manual-merge-gate-bypass unasserted) |
| butler | 0.87 | 15 | 3 | 1 | error-handling (HTTP-level), concurrency, permission/security, boundary, config (event-feed) |
| workflow-engine | 0.88 | 12 | 4 | 0 | boundary, error-handling (negative graph-validation rules), api (MCP agent entry) |
| persistence-schema | 0.90 | 13 | 1 | 1 | config (db-location resolution unverified), completeness-vs-unseeded-table (cascade walk vs future child tables), error-handling (unique-constraint rejection + restore guards) |
| agent-providers | 0.91 | 14 | 1 | 1 | error-handling (login + env-strip security paths), state-transition (full preflight verdict folding), config (env-stripping under a polluted process env) |
| git-integration | 0.94 | 16 | 2 | 0 | boundary, workflow (rebase/review path) |
| issues-board | 0.94 | 18 | 1 | 0 | concurrency, error (negative-path edges: status-delete-in-use, contraction-no-terminal-status) |
| preferences-config | 0.97 | 15 | 1 | 0 | state-transition, api(quota-endpoint), risk(start-policy kill-switch) |

_Sorted weakest-first. `permission`/`accessibility`/`cross-browser` are N/A for most API capabilities of this single-user local app and are not counted as gaps._
