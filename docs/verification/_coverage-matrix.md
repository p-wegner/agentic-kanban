# Coverage matrix — functional coverage by capability

Generated from `_coverage.json` (`render.mjs`). **NOT line coverage** — a behaviour is
"covered" only when a test asserts its observable outcome across its risk-relevant dimensions.

**Overall: 0.897 — 232 covered · 26 partial · 15 uncovered across 273 behaviours in 15 capabilities.**

| Capability | Score | Covered | Partial | Uncovered | Weakest dimensions |
|---|--:|--:|--:|--:|---|
| workspaces | 0.81 | 20 | 2 | 4 | state-transition, error |
| monitor-orchestration | 0.83 | 15 | 0 | 3 | state-transition (conductor lifecycle + re-entrancy guard untested), observability (butler logging untested), navigation (wave/contract UI surfacing not e2e-asserted) |
| codemods | 0.83 | 7 | 1 | 1 | capability, config, boundary |
| mcp-server | 0.85 | 16 | 2 | 2 | permission, workflow, concurrency, config(security egress) |
| board-ui | 0.85 | 19 | 3 | 2 | error-handling, concurrency, state-transition (negative/rejected edges), accessibility (keyboard-nav operability) |
| workflow-engine | 0.88 | 12 | 4 | 0 | boundary, error-handling (negative graph-validation rules), api (MCP agent entry) |
| project-registration | 0.88 | 14 | 2 | 1 | workflow, error-handling, state-transition |
| persistence-schema | 0.90 | 13 | 1 | 1 | config (db-location resolution unverified), completeness-vs-unseeded-table (cascade walk vs future child tables), error-handling (unique-constraint rejection + restore guards) |
| agent-providers | 0.91 | 14 | 1 | 1 | error-handling (login + env-strip security paths), state-transition (full preflight verdict folding), config (env-stripping under a polluted process env) |
| butler | 0.92 | 16 | 3 | 0 | error-handling (HTTP-level), concurrency, permission/security, boundary, config (event-feed) |
| agent-sessions | 0.93 | 17 | 3 | 0 | concurrency (reattach/exit-race, buffer-free, FK-race all partial/untested), regression (resume chain + restart survival unverified), workflow (provider-resume relaunch + multi-turn follow-up end-to-end gaps) |
| issues-board | 0.94 | 18 | 1 | 0 | concurrency, error (negative-path edges: status-delete-in-use, contraction-no-terminal-status) |
| preferences-config | 0.97 | 15 | 1 | 0 | state-transition, api(quota-endpoint), risk(start-policy kill-switch) |
| git-integration | 0.97 | 17 | 1 | 0 | boundary, workflow (rebase/review path) |
| review-merge | 0.97 | 17 | 1 | 0 | workflow (reconciler-relaunch + sync-merge land paths unasserted), api (fix-and-merge endpoint + manual-merge-gate-bypass unasserted) |

_Sorted weakest-first. `permission`/`accessibility`/`cross-browser` are N/A for most API capabilities of this single-user local app and are not counted as gaps._
