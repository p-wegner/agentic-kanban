---
repo: agentic-kanban
analyzed_sha: 29e016dc
note: Ubiquitous language merged from the 15 module docs. Terms are defined AS THE CODE USES THEM. Collisions (one word, two meanings) are called out — they are bounded-context smells.
---

# Ubiquitous Language — agentic-kanban

## Core work units
| Term | Meaning as used in code | Context |
|---|---|---|
| **Project** | One managed git repository; its `repoPath` is its identity. | issues-board |
| **Issue / Ticket** | A unit of coding work. `#N` is the per-project `issueNumber`, **not** the UUID `id`. | issues-board |
| **issueNumber** | Per-project sequential number (MAX+1), distinct from the global UUID. | issues-board, mcp-server |
| **Workspace** | The atomic unit of agent work: binds one ticket to one isolated worktree+branch and one-or-more agent runs; ends in merge (delivered) or close (abandoned). The DB row outlives the live process. | workspaces |
| **Direct workspace** | `isDirect=true`: no worktree — the agent edits the main checkout; merge is a no-op close. Exempt from merge guards. | workspaces, git-integration, review-merge, mcp-server |
| **Session** | One agent subprocess run against a workspace. | agent-sessions |
| **Worktree** | An isolated per-ticket, per-agent git checkout. | git-integration, workspaces |
| **Milestone** | A named, optionally due-dated grouping of issues toward a deliverable (per project) — the sibling of tags. Every issue carries a nullable `milestoneId` FK; unset = no milestone. | issues-board |
| **Evidence artifact** | Proof-of-work an agent attaches to its workspace/issue (Playwright `.webm` visual proof, screenshot, link, or text) so correctness is observable without re-running it. Rows in `issue_artifacts`; attached via `attach_artifact`. | workspaces |

## Status & workflow
| Term | Meaning | Context |
|---|---|---|
| **Status (column)** | A per-project *named* lane, not a global enum. Columns are workflow statuses. | issues-board, board-ui |
| **Terminal status** | Done / Cancelled / Archived — absorbing states; guarded against stranding an unmerged branch. | issues-board, mcp-server |
| **Board status (read model)** | A *derived* per-issue view. The workspace's workflow node wins over the issue's own `statusId` — board status is computed, not stored truth. | issues-board |
| **Node / stage** | One step in a workflow graph: type + status + optional skill + cycle budget. | workflow-engine |
| **currentNodeId** | Pointer to the workflow node an issue/workspace currently sits on. | workflow-engine, issues-board |
| **Condition** | An edge guard in the transition DSL (`manual` / `auto_on_exit_0` / `tests_*` / `diff_*`). | workflow-engine |
| **Fork / Join node** | Structural fan-out/fan-in node types (parallel-fork / parallel-join). | workflow-engine, workspaces |
| **maxVisits / isLoop** | Per-node visit budget (cycle protection) and a declared intentional back-edge. | workflow-engine |

## Agents & sessions
| Term | Meaning | Context |
|---|---|---|
| **Provider** | One supported AI coding CLI family (Claude / Codex / Copilot / Pi); a frozen SSOT set. | agent-providers |
| **ProviderName vs ProviderId** | Internal `claude` vs external alias `claude-code`. | agent-providers |
| **executor** | The persisted provider string (`"claude-code"`) on a session — overloaded vs the narrowed `ProviderName` (an audit trap). | agent-sessions |
| **Profile** | A named auth/config selection for a provider (per-project). | agent-providers, butler |
| **AgentLaunchConfig** | The provider-neutral spawn recipe (command/args/env + stdin hints). | agent-providers |
| **Plan mode** | A read-only "plan only, change nothing" launch; #924 contract always clears it on exit. | agent-providers, agent-sessions |
| **Launch failure** | A fast (≤10s) zero-output / non-zero exit = "the agent never really started". | agent-sessions |
| **Usage limit** | Provider quota hit → workspace blocked for credential rotation. | agent-sessions, agent-providers |
| **License / subscription ring** | A rotation set of OAuth credential directories. | agent-providers |
| **Substantive output** | Real assistant/tool/stats activity, as opposed to noise — the liveness signal. | agent-sessions |

## Orchestration
| Term | Meaning | Context |
|---|---|---|
| **Start Mode** | The per-project single-source-of-truth gate for auto-start: `manual` / `monitor` / `conductor`. Every auto-start path consults `resolveStartPolicy`. | monitor-orchestration |
| **Autopilot** | The deterministic, LLM-free in-process monitor cycle. | monitor-orchestration |
| **Conductor** | The out-of-process `loop.sh` driver; when on, the in-process engine stands down. | monitor-orchestration |
| **Monitor Butler** | An in-process *LLM* board-health agent (fresh SDK session per cycle); off by default. | monitor-orchestration |
| **WIP target / ACTIVE_AGENTS_TARGET** | The active-agent ceiling that throttles new starts. | monitor-orchestration |
| **Backlog floor** | Minimum unstarted Todo tickets before the monitor refills the backlog. | monitor-orchestration |
| **Strategy Bullseye** | A JSON pref that derives monitor tunables + provider routing — the published tuning contract. | monitor-orchestration |

> **Agent roles (operational vocabulary).** `CLAUDE.md`'s "Agent Roles" table names
> seven roles; the glossary terms above cover the in-product mechanisms but use older
> names for three of them. Reconciliation:
> - **Steward** = the in-process *LLM* monitor — **the same thing this glossary calls
>   "Monitor Butler"** (`monitor_butler_enabled`, fresh SDK session per cycle, reads
>   `objective.md`, off by default). "Steward" is the role name; "Monitor Butler" is the
>   mechanism/pref name.
> - **Sentinel** = the *human-side* watch (interactive Claude + `/loop` + cron) that
>   polls the **Conductor**'s health and reports one line, recovering only on failure.
>   Not an in-product mechanism — it's the supervisor role around the loop.
> - **Smith** = the compounding-engineering session that analyzes past runs
>   (`fleet-analysis` / `session-inspector` / `learning-step` / `distill-learnings`) to
>   forge durable improvements (skills, hooks, docs). Also not an in-product mechanism.
>
> **Autopilot** (deterministic in-process monitor), **Conductor** (out-of-process
> `loop.sh` driver), **Monitor Butler**/Steward, **Butler** (warm per-project assistant),
> and **Builder** (per-ticket worktree implementer) keep their meanings as defined here
> and in the Butler/UI section.

## Review & merge
| Term | Meaning | Context |
|---|---|---|
| **readyForMerge** | Reviewer-set approval flag — the merge engine's permission slip (self-asserted; nothing verifies the diff was read). | review-merge |
| **mergedAt / mergedHeadSha** | Timestamp + tip SHA stamped when the merge lands; survives branch deletion; a crash-recovery anchor. | review-merge, workspaces |
| **Merge queue** | Ordered batch merge by least file-overlap, skip-on-conflict. | review-merge |
| **Fix-and-merge** | Relaunch an agent in the worktree to resolve a conflict; workspace status `fixing`. | review-merge |
| **Silent merge loss** | Issue marked Done but the branch never landed on the base — the lie the reconcilers hunt. | review-merge |
| **Stranded review** | An idle, In-Review, not-ready, session-less workspace whose review handshake never fired. | review-merge |
| **Reconciler** | An interval/startup job that repairs DB status drift from git reality (e.g. done-unmerged scanner). | review-merge, workspaces |

## Butler & UI
| Term | Meaning | Context |
|---|---|---|
| **Butler** | A per-project warm conversational agent; multi-instance (up to 4 named global personas); backends claude(SDK)/codex/mock. | butler |
| **Warm session** | A live in-process query holding conversational context per (project, butler) across turns and restarts. | butler |
| **Board guide** | On-demand UI how-to surfaced by the butler (progressive disclosure). | butler |
| **Optimistic move** | Client applies a card move locally before the PATCH, with snapshot rollback on failure. | board-ui |
| **sortOrder** | Integer card rank with ~100-unit gaps for cheap reordering. | board-ui |
| **liveStats / sessionActivity** | Ephemeral per-issue agent telemetry pushed over WebSocket, never persisted, pruned on inactivity. | board-ui, agent-sessions |

## Data kernel
| Term | Meaning | Context |
|---|---|---|
| **Schema (Published Language)** | The Drizzle table set — the shared data vocabulary every package imports. Row types are the internal domain type; `types/api.ts` DTOs are the separate wire layer. | persistence-schema |
| **db / writeDb** | WAL-isolated read vs write connection handles. | persistence-schema |
| **withDbRetry** | Bounded `SQLITE_BUSY` retry policy — exists because parallel agents contend on one SQLite file. | persistence-schema |
| **Application-level cascade delete** | A hand-coded ordered deletion walk that re-encodes the FK graph in code (can drift from schema). | persistence-schema |
| **Migration journal** | `_journal.json`, the authoritative migration apply-order. | persistence-schema, git-integration |
| **gitExec / git-exec adapter** | The single never-throwing git spawn site; returns `{stdout,stderr,code,error}`. | git-integration |

## Project registration & stacks
| Term | Meaning | Context |
|---|---|---|
| **StackProfile / Stack profile** | The single durable descriptor of a repo's tech stack (family, package manager, install/build/test/dev commands, web-ness, ports, test dir/runner). The one Published-Language JSON every downstream harness piece reads. | project-registration |
| **Marker files** | The on-disk root files (`package.json`, `Cargo.toml`, `go.mod`, `build.gradle`, `pyproject.toml`, …) that rule-based detection keys off to identify a stack. | project-registration |
| **setup_script** | Monorepo-aware install command run ONCE in a fresh worktree before the first build (`pnpm install -r`, `cargo fetch`, …); persisted to the `setup_script` column and consumed by workspace provisioning. | project-registration, workspaces |
| **verify_script (merge gate)** | The keystone auto-merge gate command (`testCommand && buildCommand`); a non-zero exit withholds `readyForMerge`. Persisted to `verify_script_<projectId>`, consumed by the pre-merge gate. | project-registration, review-merge |
| **Smoke check** | A project-agnostic "does it boot and respond/render" check — boot the dev command, poll a health URL, assert HTTP 200 (+ HTML shell for browser UIs). Only for web/service projects. | project-registration, review-merge |
| **Buildable-from-clean** | Per-package-manager scaffold edits (pnpm `onlyBuiltDependencies`, bun `trustedDependencies`, `packageManager` pin) so a clean clone builds with no manual approval prompts. | project-registration |
| **profile source** | `"detected"` (rule-based) vs `"llm"` (LLM gap-filled a sparse profile) — provenance/confidence of a StackProfile. | project-registration |

## Codemod factory
| Term | Meaning | Context |
|---|---|---|
| **Codemod** | A repo-wide structural transform — concretely the body of a per-file transform function operating on a ts-morph `SourceFile`, not a script or regex. A saved codemod is persisted as an `agent_skills` row with `type='codemod'`. | codemods |
| **Transform code** | The raw JS/TS string the LLM emits from the user's intent, compiled into an `AsyncFunction(sourceFile)` — the unit of execution. | codemods |
| **Preview→apply gate** | The safety contract: preview is a pure dry-run (diffs every file in memory, writes nothing); apply is the only step that mutates the repo, and only for user-selected, in-repo paths. | codemods |
| **CODEMOD_FILE_LIMIT** | Hard ceiling (100) of TS files above which a preview refuses to run without explicit `overrideLimit` confirmation — the blast-radius guard. | codemods |

## Preferences & configuration
| Term | Meaning | Context |
|---|---|---|
| **Effective model / resolveEffectiveModel** | The model actually launched after dropping any model id that doesn't belong to the resolved provider's family (a mismatched `--model` kills the launch; provider-scoped `default_model_<provider>` only). | preferences-config |
| **Provider divergence** | Drift between the global `provider`/`*_profile` prefs and what the active project's Strategy Bullseye would select; now an enforced write-time guard (422), not just a banner. | preferences-config |
| **Harness setting** | A per-agent-harness behavior knob (`harness.<harness>.<setting>`) that means different things per provider; resolved scoped → legacy-flat → per-harness default. | preferences-config |

---

## ⚠ Term collisions (bounded-context smells)
| Word | Meaning A | Meaning B | Why it matters |
|---|---|---|---|
| **WIP** | Board-UI: a column's *visual* load classification (under/at/over). | Monitor: the agent-throttle ceiling (`nudge_wip_limit`). Only this one throttles anything. | One word, two unrelated mechanisms — readers conflate "column is full" with "monitor won't start more agents". |
| **Drive** | Monitor: a *one-switch pref set* for hands-off mode. | Monitor: a *DB record* tracking an epic/decomposition run. | Same noun, two referents within one context — a known confusion point. |
| **Mode** | `merge_strategy` (direct/monitor/merge_queue). | `ReconcileStrategy` (per-cluster merge HOW) **and** Start Mode (manual/monitor/conductor). | Three independent "mode" vocabularies; easy to misconfigure across review-merge ↔ monitor. |
| **providerSessionId / claudeSessionId** | Schema: a generic provider resume id reused across Claude/Pi/etc. | `server/CLAUDE.md` still calls it "claudeSessionId". | Doc lag on a renamed column; schema is the source of truth. |
| **Direct** | Workspace: no-worktree, edits main checkout. | (consistent across contexts) | Not a true collision — listed because its merge-no-op semantics surprise readers. |
