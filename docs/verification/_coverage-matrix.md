# Coverage matrix — functional coverage by capability

Generated from `_coverage.json` (`render.mjs`). **NOT line coverage** — a behaviour is
"covered" only when a test asserts its observable outcome across its risk-relevant dimensions.

**Overall: 0.837 — 210 covered · 37 partial · 26 uncovered across 273 behaviours in 15 capabilities.**

| Capability | Score | Covered | Partial | Uncovered | Weakest dimensions |
|---|--:|--:|--:|--:|---|
| project-registration | 0.62 | 10 | 2 | 5 | workflow, error-handling, state-transition |
| mcp-server | 0.63 | 11 | 2 | 5 | permission, workflow, concurrency, config(security egress) |
| codemods | 0.72 | 6 | 2 | 1 | capability, config, boundary |
| agent-sessions | 0.74 | 12 | 6 | 1 | concurrency (reattach/exit-race, buffer-free, FK-race all partial/untested), regression (resume chain + restart survival unverified), workflow (provider-resume relaunch + multi-turn follow-up end-to-end gaps) |
| butler | 0.74 | 12 | 4 | 1 | error-handling (HTTP-level), concurrency, permission/security, boundary, config (event-feed) |
| board-ui | 0.80 | 19 | 3 | 3 | error-handling, concurrency, state-transition (negative/rejected edges), accessibility (keyboard-nav operability) |
| workflow-engine | 0.81 | 11 | 4 | 1 | boundary, error-handling (negative graph-validation rules), api (MCP agent entry) |
| workspaces | 0.81 | 20 | 2 | 4 | state-transition, error |
| monitor-orchestration | 0.83 | 15 | 0 | 3 | state-transition (conductor lifecycle + re-entrancy guard untested), observability (butler logging untested), navigation (wave/contract UI surfacing not e2e-asserted) |
| review-merge | 0.86 | 15 | 3 | 0 | workflow (reconciler-relaunch + sync-merge land paths unasserted), api (fix-and-merge endpoint + manual-merge-gate-bypass unasserted) |
| preferences-config | 0.87 | 13 | 2 | 0 | state-transition, api(quota-endpoint), risk(start-policy kill-switch) |
| agent-providers | 0.88 | 13 | 2 | 1 | error-handling (login + env-strip security paths), state-transition (full preflight verdict folding), config (env-stripping under a polluted process env) |
| persistence-schema | 0.88 | 13 | 1 | 1 | config (db-location resolution unverified), completeness-vs-unseeded-table (cascade walk vs future child tables), error-handling (unique-constraint rejection + restore guards) |
| git-integration | 0.94 | 16 | 2 | 0 | boundary, workflow (rebase/review path) |
| issues-board | 0.94 | 18 | 1 | 0 | concurrency, error (negative-path edges: status-delete-in-use, contraction-no-terminal-status) |

_Sorted weakest-first. `permission`/`accessibility`/`cross-browser` are N/A for most API capabilities of this single-user local app and are not counted as gaps._
