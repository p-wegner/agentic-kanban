---
repo: agentic-kanban
analyzed_sha: 29e016dc
gate: PASS
scope: core-domain (13 modules); remaining capabilities explicitly deferred with reasons
note: "Re-run against a HEAD-current code-metrics analysis (1688 files). issue-dependency.service.ts + issue-error.ts (extracted post-original-analysis) folded into issues-board; the dependency-guard citations were re-anchored from the old issue.service.ts lines to the new sub-service. Tooling roots (scripts/, .claude/) and packages/desktop deferred as non-product. Gate PASS at blast-threshold 120."
---

# Coverage & completeness report (Phase 4a)

Answers the three questions per-module review structurally cannot:
**did we cover the whole codebase? did we miss an important module? does all code map somewhere?**

Produced deterministically by `domain-docs/tools/coverage.py`
(`source − owned − deferred = unmapped`, importance = blast radius / `refactor_first` / top-churn).

## Summary
| Metric | Value |
|--------|-------|
| Product source files (non-test, TS/JS) | 1020 |
| Mapped to a module | 187 (18.3%) |
| Unmapped | 833 |
| **Important unmapped, undecided** | **0** |
| **Coverage gate** | **PASS** |

**18% mapped is by design, not by accident.** This was a deliberately core-scoped run.
The gate's bar is *not* "% mapped" — it is "**no important file (high blast radius /
`refactor_first` / top-churn) left unmapped without an explicit decision**". Before this
check the run silently omitted **104 important files**; the check forced each into one of:
documented now, queued as a new module, folded into an existing module, or deferred long-tail.

## What the coverage check caught (the honest answer to "did we miss a module?")
**Yes — it missed 5 real capabilities.** The biggest, `preferences-config`, has the
highest-blast-radius files in the whole unmapped set (`preference-keys.ts` 236,
`effective-config` 212, `strategy-objective` 204). It is now **documented**
([preferences-config.md](preferences-config.md)) — closing the loop the check exists to force.
The other four are queued (real, scoped out of *this* pass, not forgotten).

## Important-unmapped → disposition
| Group | Example high-blast files | Disposition |
|-------|--------------------------|-------------|
| **Preferences & config** | `preference-keys.ts` (236), `effective-config` (212), `strategy-objective` (204), `agent-settings` (191), `start-policy` (184) | ✅ **Documented now** → `preferences-config.md` |
| **Project registration / stack profiles / scaffold** (turnkey driver) | `stack-detector` (139), `stack-profile/*` (135-138), `project-setup` (141), `project-scaffold`, `project.service` | ⏭ **New module queued** |
| **CLI surface** | `cli/commands/*` (`issue.ts` churn 32, …) | ⏭ **New module queued** |
| **Client app shell & flows** | `SettingsPanel.tsx` (risk 0.79 — #1 hottest), `Layout.tsx` (churn 233), `CreateIssue*`, `CreateWorkspaceForm`, `GraphView`, `DiffViewer` | ⏭ **New module queued** |
| **Server bootstrap & lifecycle** | `server-start.ts` (churn 373), `startup/*` reconcilers not owned by monitor/review, `process-cleanup` | ⏭ **New module queued** |
| **Workspace service internals** | `workspace-internals` (153/0.58), `workspace-merge.service` (0.66), `workspace-crud.service` (0.62), `workspace-summary/session.service` | 🔁 **Fold into** workspaces / review-merge |
| **Issue services** | `issue-service.repository` (260), `issue-ai.service` | 🔁 **Fold into** issues-board |
| **Agent CLI / fork / review services** | `claude-cli.service` (160), `workflow-fork.service`, `review.service` | 🔁 **Fold into** agent-providers / workflow-engine / review-merge |
| **Cross-cutting kernels** | `errors/index.ts` (294), `routes/index.ts`, `types/api.ts` (wire DTO layer) | 📎 **Covered in README cross-cutting** (wiring/error-mapping, not a domain context) |
| **Analytics / drive / voice / charts long-tail** | `quality-metrics*`, `drive-obstacles*`, `failure-pattern*`, `bisect*`, `voice-capture*`, client charts, the ~50 uniform MCP tools | 🗄 **Deferred long-tail** — document on demand |

Full machine-readable dispositions: the `deferred` array in [`_plan.json`](_plan.json) (50 buckets, each with a reason). Re-run `tools/coverage.py` to verify the gate.

## Cluster coverage (structure.md)
Every `structure.md` cluster with real cohesion maps to ≥1 module:
| Cluster | Covering module(s) |
|---------|--------------------|
| C1 `repositories` (server) | issues-board, workspaces, review-merge, persistence-schema, **preferences-config**, monitor-orchestration (+ queued: project-registration, cli, bootstrap) |
| C2 `hooks` (client) | board-ui (+ queued: client-shell; deferred: analytics/charts) |
| C3 `mcp-server` | mcp-server (core 11 tools; long-tail tools deferred) |
| C5/C6 `shared` | persistence-schema, git-integration, workflow-engine, agent-sessions |
| C7 `butlerchatparts` | butler |
| C8 `boardcolumn` | board-ui |
| C9 `agent-provider` | agent-providers |
| C4/C10–C17 (e2e, scripts, skills, hooks, test-pairs) | deferred (non-product / tooling) |

## Residual decision
This is a **core-domain pass**: the central agentic loop (issues → workspaces → agents →
sessions → review → merge, plus the orchestration, butler, MCP, git, persistence, config,
and board UI around it) is documented and reviewed. The 5 queued modules and the long-tail
are named follow-ups, not silent gaps. A follow-up run adds them to `_plan.json` `modules`,
runs Phase 2/3/4 for them, and re-passes this gate at a higher % mapped.
