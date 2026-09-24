---
generated: 2026-09-24T18:38:25.425Z
commit: 47a6ff5b886ff2bab09600defb58a9d255b72bc4
endpoints: 375
source: packages/server/src/routes
---

# API Endpoint Catalog

> Auto-generated & maintained by the `endpoint-docs` skill.
> Regenerate: `node .claude/skills/endpoint-docs/endpoint-docs.mjs update`.
> Query: `… endpoint-docs.mjs find <q>` · `get <METHOD> <path>` · `usage <path>`.

Columns — **Request**: named type, `{field, …}` inline shape, `json` (untyped body), or `—` (none). **Response**: the producing service call `name()`, `{field, …}` literal, or `json`.

## agent-questions

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/agent-questions | — | {questions} | list pending questions for the project. |
| DELETE | /api/projects/{id}/agent-questions/{toolUseId} | — | {ok, dismissed, dismissedAt} | Dismiss a pending question. Records `{ dismissed: true, dismissedAt }` under the answered pref key (keeps the row for audit) so it drops out of the pending list. The corresponding workspace is intenti |
| POST | /api/projects/{id}/agent-questions/{toolUseId}/answer | json | {ok, sessionId, resumed, content} | Body: { questions: AgentQuestion[], answers: [{ selectedLabels: string[], freeText?: string }, ...], workspaceId: string } |
| POST | /api/projects/{id}/agent-questions/{toolUseId}/recommend | — | {ok, recommendations} | Useful for manual re-trigger and tests. The background path inside listAgentQuestions already fires recommendations automatically when none is cached, so a client usually does not need to call this. |

## agent-skills

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/agent-skills | — | listSkills() | list skills |
| POST | /api/agent-skills | — | skill | create a skill |
| DELETE | /api/agent-skills/{id} | — | {success} | — |
| GET | /api/agent-skills/{id} | — | getSkill() | get a single skill |
| PUT | /api/agent-skills/{id} | {name?, description?, prompt?, model?, projectId?, …} | updated | update a skill |
| POST | /api/agent-skills/{id}/install | {projectId?} | installSkill() | — |
| GET | /api/agent-skills/{id}/install-status | — | getInstallStatus() | — |
| POST | /api/agent-skills/enhance | json | enhanceSkill() | AI-enhance a skill name, description, and prompt |
| GET | /api/agent-skills/install-status | — | getAllInstallStatuses() | batch install-status for all skills in one pass (registered before /:id so the static path wins over the :id param route). |

## approvals

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/approvals | {sessionId, toolName, toolInput} | {id} | Create a new approval request (called by MCP approve_tool_use tool) |
| DELETE | /api/approvals/{id} | — | {ok} | Clean up after MCP tool is done |
| GET | /api/approvals/{id} | — | {id, decision} | Get approval status (polled by MCP tool) |
| PUT | /api/approvals/{id} | {decision} | {ok} | Resolve approval (called by UI) |

## backlog-markdown

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/backlog.md | — | — | — |
| POST | /api/projects/{projectId}/backlog.md/import | — | result | — |
| POST | /api/projects/{projectId}/backlog.md/preview | — | preview | — |

## backlog-snapshot

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/backlog/export | — | — | → downloadable JSON snapshot. |
| POST | /api/projects/{projectId}/backlog/import | — | result | Accepts a multipart "file" upload OR an application/json body that is either the snapshot object itself or { snapshot }. Returns the import result summary. |

## board-monitor

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/projects/{id}/auto-merge/resume | — | {ok, cleared, breaker} | "I fixed it, try again" door; the other two clears are automatic (the base sha moves, or the failing workspace's setup verdict changes). Clear the same-failure circuit breaker and let this project's a |
| GET | /api/projects/{id}/autopilot | — | status | #1102: one glance for the toolbar Autopilot chip — Start Mode, running vs. limit, how many tickets the NEXT cycle starts (through the monitor's own `decideStartSlots`), the hold that stops it, and the |
| GET | /api/projects/{id}/board-monitor/next | — | {projectId, candidates} | #917: top-N ranked Todo-pull candidates for this project, by the same score the pull loop actually uses — makes the FIFO-replacement decision explainable in the Monitor view instead of a number nobody |
| POST | /api/projects/{id}/conductor | — | {status} | Start/stop the out-of-process Conductor loop (dogfood board only). The Start Mode UI calls this when the user picks "conductor" (start) vs manual/monitor (stop). |
| GET | /api/projects/{id}/conductor-schedule | — | {available, schedule} | Cron schedule for the off-process Conductor (ticket #841). The continuous loop above is always-on; this drives one off-process cycle per scheduled tick instead. Config is a single per-project JSON pre |
| PUT | /api/projects/{id}/conductor-schedule | — | {available, schedule} | — |
| GET | /api/projects/{id}/delivery | — | status | #1155: one glance for the header chip — the EFFECTIVE risk posture plus the EFFECTIVE merge-train numbers, both server-resolved. Read-only; the panel behind it (#1156) writes through the existing `PUT |
| GET | /api/projects/{id}/monitor-tunables | — | {tunables, source, startPolicy, capacity, diskHealth} | — |
| GET | /api/projects/{id}/orchestrator | — | readOrchestratorStatus() | — |

## butler

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| DELETE | /api/projects/{id}/butler | — | {ok} | Clearing the persisted session id means the NEXT ensure starts a fresh session, which re-reads the (possibly customized) butler skill — so "stop butler" is how users apply skill/behavior changes. |
| GET | /api/projects/{id}/butler | — | {butlerId, backend, active, sessionId, contextTokens, …} | current butler state (for the selected ?butler=<id>) |
| POST | /api/projects/{id}/butler/answer | json | {ok} | answer a parked AskUserQuestion (#460). The butler's canUseTool handler suspended the SDK turn on this askId; resolving it hands the model the user's choices and the turn continues. |
| POST | /api/projects/{id}/butler/ask | json | {sessionId, text, isError} | synchronous: send a turn, wait for the full answer, and return it in one response. This is the primitive used by the CLI and MCP tool (separate processes that cannot read the server's in-memory SSE st |
| GET | /api/projects/{id}/butler/commands | — | {commands} | Merges what the live SDK session reports with the repo's own .claude/skills/*/SKILL.md (so repo skills are always suggested, even before the SDK finishes discovery or for a project whose session isn't |
| POST | /api/projects/{id}/butler/ensure | — | {active, sessionId} | start the warm session if not running |
| POST | /api/projects/{id}/butler/interrupt | — | {ok} | stop the in-flight turn (keeps the session warm) |
| POST | /api/projects/{id}/butler/message | json | {ok} | send a turn to the warm session |
| GET | /api/projects/{id}/butler/messages | — | {messages} | conversation history for the active session, so the chat UI can restore prior messages after a page reload. |
| POST | /api/projects/{id}/butler/model | json | {ok, model, applied} | restarting (preserves context, per the design). The model lives on the (global) butler definition, so this updates the definition and applies it live to the selected butler's warm session in this proj |
| POST | /api/projects/{id}/butler/profile | json | {ok, profile, active} | switch the Claude profile. A profile changes auth/endpoint, which cannot change mid-session, so this RESTARTS the butler fresh (forgets the resume id) per the design ("restart only where needed"). |
| GET | /api/projects/{id}/butler/profiles | — | {provider, profiles, selected, globalDefault} | available profiles + the butler's current selection ("" = inherit the global profile). |
| GET | /api/projects/{id}/butler/sessions | — | {sessions} | list recent butler sessions from disk JSONL |
| GET | /api/projects/{id}/butler/sessions/{sid}/messages | — | {messages} | transcript of a past session |
| GET | /api/projects/{id}/butler/skill | — | {prompt, isOverride} | the editable butler prompt + whether a project-scoped override exists (vs the global default). |
| PUT | /api/projects/{id}/butler/skill | json | {ok, isOverride} | upsert the project-scoped butler override. An empty prompt removes the override (revert to the global default). |
| GET | /api/projects/{id}/butler/stream | — | — | SSE stream of butler events |
| GET | /api/projects/{id}/butlers | — | {butlers} | all defined butlers + this project's per-butler runtime state (warm/cold, busy, context). Powers the butler switcher. |

## butler-definitions

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/butler-definitions | — | {butlers, max} | list defined butlers (always includes "default"). |
| POST | /api/butler-definitions | — | {butler} | create a named butler { name, model?, provider? }. |
| DELETE | /api/butler-definitions/{bid} | — | {ok} | remove a named butler ("default" is protected). |
| PUT | /api/butler-definitions/{bid} | {name?, model?, provider?} | {butler} | update name, model, and/or provider. |

## codemods

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/codemods | — | codemods | * GET /api/codemods?projectId=<id>    * Returns saved codemods (agent_skills with type='codemod') for a project. |
| POST | /api/codemods | json | {type} | * POST /api/codemods    * Body: { name, description, script, projectId? }    * Save a codemod to agent_skills with type='codemod'. |
| GET | /api/codemods/{id} | — | skill | * GET /api/codemods/:id    * Returns a single saved codemod. |
| POST | /api/codemods/apply | json | result | * POST /api/codemods/apply    * Body: { projectId: string, changes: [{filePath, modified}], selectedFiles?: string[] }    * Returns: { applied: string[], skipped: string[] }    *    * `projectId` |
| POST | /api/codemods/preview | json | {script, description, files, totalTsFiles, limitReached} | * POST /api/codemods/preview    * Body: { description: string, projectId: string, overrideLimit?: boolean, script?: string }    * Returns: { script, description, files: [{filePath, relativePath, dif |

## config-export-import

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/config/export | — | — | — |
| POST | /api/projects/{projectId}/config/import | — | {ok, statusChanges, prefChanges, strategyChanged, droppedKeys} | — |

## digest

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/digest | — | computeDigest() | `now` is injectable for deterministic time-window tests (nowOverride pattern). |

## drive

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/drive | — | getDriveStatus() | — |
| PUT | /api/projects/{projectId}/drive | json | setDriveEnabled() | — |
| GET | /api/projects/{projectId}/drive/preflight | — | runDrivePreflight() | — |
| POST | /api/projects/{projectId}/drive/preflight | {autoRepair?} | runDrivePreflight() | — |

## drive-obstacles

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/drive-obstacles | — | map() | queryable log |
| POST | /api/projects/{projectId}/drive-obstacles | json | {id} | record one obstacle |
| GET | /api/projects/{projectId}/drive-obstacles/summary | — | {total, byKind} | per-kind breakdown for the dashboard |

## drives

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/drives | — | list() | — |
| POST | /api/projects/{projectId}/drives | — | result | starts a drive |
| DELETE | /api/projects/{projectId}/drives/{id} | — | {success} | — |
| GET | /api/projects/{projectId}/drives/{id} | — | get() | — |
| PUT | /api/projects/{projectId}/drives/{id} | json | result | — |
| GET | /api/projects/{projectId}/drives/{id}/dashboard | — | dashboard | aggregated drive view (#800) |
| POST | /api/projects/{projectId}/drives/{id}/extend | — | result | Re-enter a drive (active or completed) with a one-line addendum (#1132): appends a new `## Increment N` section to the epic, reactivates the drive if it was completed, and returns the epic so the call |
| POST | /api/projects/{projectId}/drives/{id}/finish | {status?} | result | — |
| POST | /api/projects/{projectId}/drives/{id}/plan | — | result | same request, so the UI can open straight to the reviewable preview; a plain call makes no model call, unchanged. Seed a target-only drive's meta/epic issue from its target, and link the drive to it. |
| GET | /api/projects/{projectId}/drives/{id}/review-effectiveness | — | {drive} | Per-drive AI code-review effectiveness: reviews run, reviews that bounced a ticket back to building, and merged-without-review — scoped to the drive's time window and (unless ?wholeProject=true) the m |

## failure-patterns

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/failure-patterns | — | listPatterns() | list all stored patterns |
| POST | /api/failure-patterns | json | pattern | create a pattern manually |
| DELETE | /api/failure-patterns/{id} | — | {ok} | — |
| POST | /api/failure-patterns/ingest | json | {ingested} | ingest a markdown file |
| GET | /api/failure-patterns/search | — | map() | find similar failures |

## focus

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/focus | — | computeFocus() | `now` is accepted for parity with the digest route and deterministic tests; the focus ranking itself is point-in-time, not windowed. |

## health

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/health | — | {status, ok, checks, db} | still listening, so a naive "status: ok" probe stays green while every DB-backed API route fails with ERR_MODULE_NOT_FOUND. Reporting "degraded" here lets monitors detect a board that is up but unusab |
| GET | /api/health/deps | — | result | — |

## herdr

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/herdr/availability | — | availability | — |

## inbox

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/inbox | — | listInbox() | — |

## insights

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/insights | — | data | — |

## internal

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/internal/board-notify | {projectId?, reason?} | {ok} | Internal endpoint for MCP/CLI tools to trigger immediate board refresh |
| POST | /api/internal/workflow-advanced | {workspaceId?} | {ok} | Internal endpoint: a workflow transition happened (e.g. via the MCP propose_transition tool in the separate MCP process). Run fork/join orchestration in the main server, which owns the session manager |

## issue-export-import

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/issues/export | — | {error} | — |
| POST | /api/projects/{projectId}/issues/import | — | {created, skipped, skippedRows, parseErrors, warnings} | (format = auto/csv/markdown/json), or a multipart form with a "file" field. Parses (CSV / Markdown / JSON), skips malformed rows, and bulk-creates the rest into the project's default (Backlog) status. |
| POST | /api/projects/{projectId}/issues/import/preview | — | {format, rows, skipped, warnings, parseErrors} | Parse text WITHOUT persisting. Accepts JSON { text, format } or a multipart "file" upload. Returns the detected format, resolved preview rows, and any per-row warnings/skips so the client can show a p |

## issues

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/issues | — | {error} | slim=1 omits the description field (the bulk of the payload) — opt-in, default response shape unchanged. |
| POST | /api/issues | json | result | — |
| DELETE | /api/issues/{id} | — | {success} | — |
| GET | /api/issues/{id} | — | {tags} | — |
| GET | /api/issues/{id}/activity | — | result | chronological audit feed aggregated from workspaces/sessions/comments |
| POST | /api/issues/{id}/analyze-touched-files | json | analyzeTouchedFiles() | run (or re-run) AI prediction |
| GET | /api/issues/{id}/artifacts | — | getArtifacts() | — |
| POST | /api/issues/{id}/artifacts | json | {id} | — |
| DELETE | /api/issues/{id}/artifacts/{artifactId} | — | {success} | — |
| GET | /api/issues/{id}/comments | — | page | the repository), `?before=<ISO>` is the keyset cursor for older pages. The response carries `totalCount`/`hasMore`/`nextCursor` ALONGSIDE the unchanged `comments` array, so an existing client keeps wo |
| POST | /api/issues/{id}/comments | json | comment | — |
| DELETE | /api/issues/{id}/comments/{commentId} | — | {success} | — |
| GET | /api/issues/{id}/cycle-time | — | result | per-status time aggregation derived from workflow transitions |
| POST | /api/issues/{id}/decompose | json | decomposeEpic() | AI-generate epic decomposition proposal |
| POST | /api/issues/{id}/decompose/confirm | json | result | confirm epic decomposition and create child issues |
| POST | /api/issues/{id}/decompose/too-small | json | {ok} | persist the decomposer's "already right-sized, don't split" verdict (#1074/#1134) so the epic stays a valid start candidate instead of being mistaken for a never-decomposed drive epic. |
| GET | /api/issues/{id}/dependencies | — | getDependencies() | — |
| POST | /api/issues/{id}/dependencies | json | {id, type} | — |
| DELETE | /api/issues/{id}/dependencies/{depId} | — | {success} | — |
| GET | /api/issues/{id}/detail-bundle | — | {issue, workspaces, tags, dependencies, artifacts, …} | cacheable endpoints, and the individual per-issue endpoints stay alive for other callers (MCP/CLI/mutation refetches). Each sub-result is independent: a failure degrades that field rather than failing |
| POST | /api/issues/{id}/duplicate | — | result | — |
| GET | /api/issues/{id}/merged-commits | — | result | commits that landed on the default branch for this issue |
| POST | /api/issues/{id}/preflight | json | {clarificationsBlock} | persisted as a durable `preflight-clarification` comment and folded into the prompt for the re-check. The returned `clarificationsBlock` is the markdown the caller can prepend to the launching agent's |
| GET | /api/issues/{id}/related-issues | — | result | find other issues that share touched files with this one |
| PUT | /api/issues/{id}/repos-touched | json | {reposTouched} | scope and no way to get one. Deliberately a SET, not an append: deselecting has to remove, or the field is a one-way ratchet. Unknown names are dropped and the applied set is echoed back, so a client |
| GET | /api/issues/{id}/summary | — | result | — |
| GET | /api/issues/{id}/tags | — | getTags() | — |
| POST | /api/issues/{id}/tags | json | result | idempotent (#1107): attaching an already-attached tag returns the existing join row with 200 instead of minting a second one with 201. |
| DELETE | /api/issues/{id}/tags/{tagId} | — | {success} | — |
| GET | /api/issues/{id}/touched-files | — | result | return cached prediction only (no AI call) |
| GET | /api/issues/{id}/workspaces | — | getEnrichedWorkspaces() | — |
| POST | /api/issues/analyze-dependencies | json | result | AI-analyze dependencies for an issue |
| POST | /api/issues/archive-done | json | {archived} | move Done issues older than N days to Archived |
| POST | /api/issues/batch | json | result | create N issues atomically Optional: parentIssueId wires child_of edges; driveTarget (requires parentIssueId) auto-creates a Drive record. |
| GET | /api/issues/burndown | — | getBurndownChart() | createdAt + current status + statusChangedAt). Registered before the `/:id` catch-all: literal sub-paths must precede it or Hono's order-sensitive router (fallback for this router's nested params) sha |
| GET | /api/issues/cfd | — | getCfdChart() | Returns one entry per (date, status) pair: the count of issues that were in that status as of the end of that day (based on statusChangedAt or createdAt when no explicit status change is recorded). |
| POST | /api/issues/contract | json | contractCoupledComponent() | propose contracting coupled components into single tickets. The documented INVERSE of /decompose: decompose splits one epic into many; contract collapses a coupled component (coupled_with peers) back |
| POST | /api/issues/contract-coupled | json | {leadIssueId, memberIssueIds, mutations, added, removed, …} | contract a full coupled_with component onto one lead. |
| POST | /api/issues/contract/confirm | json | result | apply a contract proposal (keep survivor, absorb the rest). |
| POST | /api/issues/dependencies/batch | json | {added, removed, skipped} | add/remove N dependency edges atomically |
| POST | /api/issues/enhance | json | enhanceIssue() | AI-enhance a ticket title and description |
| POST | /api/issues/group-scan | json | result | group as ONE workspace. Preview by default; `apply: true` creates the edges. `mode: "touched-files"` (#918) is the deterministic seed for a cold backlog — no LLM call, grouped by shared predicted file |
| GET | /api/issues/lead-time | — | getLeadTimeChart() | lead time trend: median + p90 per day for issues that reached Done. Lead time = Done statusChangedAt - createdAt (wall-clock age of the issue). Returns one bucket per day in the trailing window; bucke |
| GET | /api/issues/throughput | — | getThroughputChart() | daily throughput: count of issues moved to Done per calendar day. Uses statusChangedAt to identify when issues entered the Done status. Returns one data point per day for the trailing `days` window (d |

## merge-queue

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/merge-queue | json | {ok, dryRun, plan} | * POST /api/merge-queue    *    * body: { workspaceIds: string[], dryRun?: boolean, skipOnConflict?: boolean, strategy?: "sequential" / "train" }    *    * - dryRun: true  → returns JSON plan (sor |
| POST | /api/merge-queue/preview/{workspaceId} | — | {ok, preview} | * POST /api/merge-queue/preview/:workspaceId    *    * Dry-run conflict preview for a single workspace. Read-only — does not mutate the worktree.    * Returns: WorkspaceConflictPreview |
| GET | /api/merge-queue/trains | — | body | * GET /api/merge-queue/trains?projectId=    *    * History of persisted release trains for a project (#906) — newest first, including    * `abandoned` rows the startup reconciler left behind. What |
| GET | /api/merge-queue/trains/{id} | — | {ok, train} | * GET /api/merge-queue/trains/:id    *    * A single train row, with `gateEvidence`/`bisectResult` parsed and the bisect-tree    * `attempts` (#1189) lifted to the top level — the shape `pnpm cli - |
| POST | /api/merge-queue/trains/{id}/cancel | — | {ok, stoppedAfter} | * POST /api/merge-queue/trains/:id/cancel    *    * #1153 — the only remedy an operator had for a stranded train was a full server restart    * (the reconciler resumes an `assembling`/`gating` row |
| GET | /api/merge-queue/window | — | response | * GET /api/merge-queue/window?projectId=    *    * The departure board (#1186): the project's merge-train batching window as the orchestrator    * persisted it on its last tick (`train_window_<proj |
| POST | /api/merge-queue/window/hold | json | {ok, window} | * POST /api/merge-queue/window/hold    *    * body: { projectId, minutes }    *    * Operator "hold the door" (#1186): no release before `now + minutes`, whatever the size or    * wait say; `minu |
| POST | /api/merge-queue/window/release | json | {ok, window} | * POST /api/merge-queue/window/release    *    * body: { projectId }    *    * Operator "depart now" (#1186): stamps `releaseRequestedAt`; the orchestrator's next tick    * releases the pending s |

## metrics

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/metrics/loop-lag | — | {loopLag, warnThresholdMs} | — |
| GET | /api/metrics/slow-requests | — | {entries, loopLag, loopLagWarnThresholdMs} | — |

## milestones

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/milestones | — | list() | — |
| POST | /api/projects/{projectId}/milestones | — | result | — |
| DELETE | /api/projects/{projectId}/milestones/{id} | — | {success} | — |
| PUT | /api/projects/{projectId}/milestones/{id} | {name?, dueDate?} | result | — |

## plugins

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/plugins | — | listPlugins() | — |
| POST | /api/plugins | json | installPlugin() | — |
| DELETE | /api/plugins/{id} | — | {success} | — |
| POST | /api/plugins/{id}/disable | — | disableForProject() | — |
| GET | /api/plugins/{id}/docs/* | — | {error} | serve one declared doc from the plugin checkout. |
| POST | /api/plugins/{id}/enable | {projectId?, location?} | enableForProject() | #318: `location` is OPTIONAL and applied before scaffolding. Enabling scaffolds into the resolved output repo, so choosing the location afterwards left the scaffold in the wrong repo. Omitting it pres |
| GET | /api/plugins/{id}/loops | — | listLoops() | — |
| POST | /api/plugins/{id}/loops/{name}/advance | — | advanceLoop() | — |
| GET | /api/plugins/{id}/loops/{name}/artifact | — | getLoopArtifact() | A declared loop artifact, read fresh from the output repo (#288). `withDiff=1` opts into the extra `git diff` spawn (#421) — omit it for the Rendered/Raw open, which is the overwhelming majority of re |
| PUT | /api/plugins/{id}/loops/{name}/artifact | — | saveLoopArtifact() | Edit-then-approve (#305): overwrite one of the current gate's artifacts and commit it. |
| GET | /api/plugins/{id}/loops/{name}/events | — | listLoopEvents() | Audit timeline + per-unit cost rollup for one loop (#292, #294). |
| POST | /api/plugins/{id}/loops/{name}/gate/draft | — | draftLoopGateFeedback() | Draft-with-butler (#310): rough notes in, submit-ready revision feedback out. |
| POST | /api/plugins/{id}/loops/{name}/gate/resolve | — | resolveLoopGate() | Apply a human's gate decision (#286): run the plugin's resolve command, then re-plan. |
| POST | /api/plugins/{id}/loops/{name}/gate/summarize | — | summarizeLoopGate() | Summarize-for-me (#330): decision-ready butler digest of the current gate's artifacts. |
| POST | /api/plugins/{id}/loops/{name}/pause | — | setLoopPaused() | — |
| POST | /api/plugins/{id}/loops/{name}/resume | — | setLoopPaused() | — |
| GET | /api/plugins/{id}/output-location | — | getOutputLocation() | — |
| POST | /api/plugins/{id}/output-location | — | setOutputLocation() | — |
| GET | /api/plugins/{id}/scaffold | — | getScaffoldForm() | The scaffold's unresolved TODO markers as a form (#291). |
| POST | /api/plugins/{id}/scaffold | — | fillScaffoldForm() | — |
| PUT | /api/plugins/{id}/scaffold | — | saveScaffoldContent() | Overwrite the whole scaffold file (#438). `POST` addresses TODO markers by index, so a COMPLETE profile — which has none — was uneditable from the board entirely. |
| POST | /api/plugins/{id}/scripts/{name}/run | — | runScript() | — |
| POST | /api/plugins/{id}/skills/{name}/run | {projectId?, title?, description?, prompt?, workflowTemplateId?} | result | — |
| GET | /api/plugins/{id}/sync/config | — | getSyncConfig() | — |
| POST | /api/plugins/{id}/sync/config | — | setSyncConfig() | — |
| GET | /api/plugins/{id}/sync/status | — | getSyncStatus() | — |
| POST | /api/plugins/{id}/sync/trigger | — | triggerSync() | — |
| POST | /api/plugins/{id}/sync/validate | — | validateSync() | — |
| POST | /api/plugins/{id}/update | — | updatePlugin() | — |
| GET | /api/plugins/{id}/views | — | listViews() | — |
| POST | /api/plugins/{id}/views/{viewId}/start | — | startView() | — |
| POST | /api/plugins/{id}/views/{viewId}/stop | — | stopView() | — |
| GET | /api/plugins/docs | — | listPluginDocs() | Plugin-authored docs (manifest `docs[]`) — the Plugins menu's guide entries. Listed from installed manifests only, so a board without a plugin never learns that plugin's name. |
| GET | /api/plugins/marketplace | — | listMarketplace() | — |
| POST | /api/plugins/validate | json | validatePluginSource() | Parse + reference-check a local plugin dir WITHOUT installing (#295). |
| GET | /api/projects/{projectId}/plugin-surface | — | listProjectSurface() | — |
| GET | /api/projects/{projectId}/plugin-views | — | listProjectViews() | — |

## preferences

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/preferences/active-project | — | {projectId, value} | — |
| PUT | /api/preferences/active-project | {projectId?} | {projectId, value} | — |
| GET | /api/preferences/agent-profiles/health | — | {profiles} | — |
| POST | /api/preferences/agent-profiles/preflight | {provider?, profileName?} | result | — |
| POST | /api/preferences/claude-login | {configDir?} | {ok, configDir, command} | open a real terminal running `claude /login` for a subscription dir. The OAuth flow needs a foreground window, so this is the only way to do it from the UI; returns the equivalent manual command too. |
| GET | /api/preferences/claude-profiles | — | {profiles} | list available claude profiles |
| GET | /api/preferences/claude-subscriptions | — | {subscriptions} | unified view of selectable Claude subscriptions (auto-discovered ~/.claude-<name> dirs merged with the rotation ring) + login status. Mirrors /codex-licenses. |
| GET | /api/preferences/codex-licenses | — | {licenses} | unified view of selectable Codex licenses (auto-discovered ~/.codex-<name> dirs merged with the rotation ring) + login status. |
| POST | /api/preferences/codex-login | {codexHome?} | {ok, codexHome, command} | open a real terminal running `codex login` for a license dir. The OAuth callback needs a foreground window, so this is the only way to do it from the UI; returns the equivalent manual command too. |
| GET | /api/preferences/codex-profiles | — | {profiles} | list available codex profiles |
| GET | /api/preferences/copilot-profiles | — | {profiles} | — |
| GET | /api/preferences/herdr-availability | — | detectHerdrAvailabilityLive() | reachability gate (#1144). The client uses this to decide whether Herdr may be OFFERED as a selectable provider at all; never trust a stored `provider=herdr` preference alone as proof it's usable on t |
| GET | /api/preferences/herdr-profiles | — | {profiles} | — |
| GET | /api/preferences/home-dir | — | {homeDir, sep} | so the client can infer a Codex license's default CODEX_HOME (`<home>/.codex-<profile>`) without re-implementing path joins. |
| GET | /api/preferences/mcp/health | — | getMcpHealthSummary() | — |
| POST | /api/preferences/mcp/probe | — | probeMcpHealth() | — |
| GET | /api/preferences/pi-profiles | — | {profiles} | — |
| GET | /api/preferences/provider-divergence | — | getProviderDivergence() | Returns whether the global provider/profile prefs diverge from the project's Strategy Bullseye. The Bullseye is the single source of truth for workspace creation and the butler; divergence means the S |
| GET | /api/preferences/quota-usage | — | data | live quota from tampermonkey-direct |
| GET | /api/preferences/settings | — | getSettings() | get all agent settings |
| PUT | /api/preferences/settings | Record<string, string> | {ok, applied} | dropped keys — so a mistyped / un-registered setting fails loudly instead of silently no-op'ing the way auto_rebase_on_continue and skip_preflight once did (#874). |
| GET | /api/preferences/settings-bootstrap | — | {settings, claudeProfiles, codexProfiles, copilotProfiles, piProfiles, …} | the browser's ~6-connection per-host HTTP/1.1 cap (which was queuing the requests to ~1.2s). The heavy/secondary probes — agent-profile health (~600ms), mcp health, install-status, branches — stay sep |

## profile-roster

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/profile-roster | — | parse() | — |

## project-analytics

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/board-risk-digest | — | digest | — |
| POST | /api/projects/{id}/check-overlap | json | checkIssueOverlap() | check for file overlap between issues using cached predictions |
| GET | /api/projects/{id}/dashboard/throughput-by-provider | — | computeThroughputByProvider() | Rank providers/profiles by issues merged to master within a selectable time window. Returns count + median lead time per provider. |
| GET | /api/projects/{id}/dependency-waves | — | result | — |
| POST | /api/projects/{id}/dependency-waves/start-next | — | result | — |
| GET | /api/projects/{id}/file-contention | — | result | live file contention heatmap for active/reviewing workspaces |
| GET | /api/projects/{id}/monitor-cycles | — | cycles | aggregated cycle summaries |
| GET | /api/projects/{id}/sprint-capacity | — | result | — |
| GET | /api/projects/{id}/workspace-launch-failures | — | result | — |
| GET | /api/projects/{id}/workspace-risk | — | result | risk heatmap for active/review workspaces |

## project-health

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/base-branch-health | — | {latest, history, sweep} | latest + recent history of base-branch verify runs (#491) |
| POST | /api/projects/{id}/base-branch-health/reprobe | — | {started, skippedReason, joinedRunningProbe, previousOutcome, previousSha, …} | this cannot start a second full verify ALONGSIDE a running one — only reach the same queue a gate itself would use. The response says which of those happened instead of always claiming it started one. |
| GET | /api/projects/{id}/board-health-events | — | map() | — |
| GET | /api/projects/{id}/board-health-events/{eventId} | — | toBoardHealthEventDetail() | full event details (not compacted) |
| GET | /api/projects/health | — | result | aggregated health overview for all registered projects |

## project-scripts

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/scripts | — | list() | — |
| POST | /api/projects/{projectId}/scripts | json | create() | — |
| DELETE | /api/projects/{projectId}/scripts/{scriptId} | — | {success} | — |
| PATCH | /api/projects/{projectId}/scripts/{scriptId} | json | update() | — |
| POST | /api/projects/{projectId}/scripts/{scriptId}/run | — | — | — |

## project-stack-profile

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/stack-profile | — | {projectId, profile} | the durable per-project stack descriptor (#786). Returns the persisted profile; computes+persists one on demand if absent (?refresh=true forces a recompute). The feedback harness reads this ONE descri |
| PUT | /api/projects/{id}/stack-profile | Partial<StackProfile> | {projectId, profile} | Persists the profile ONLY — no scaffold writes (#41): `.claude/smart-hooks-rules.json` is TRACKED after registration committed it, so regenerating it here would leave a modified tracked file in the us |

## projects

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects | — | — | (?includeArchived=true to include archived projects) |
| POST | /api/projects | {repoPath?, cloneUrl?, name?, description?, color?, …} | result | — |
| DELETE | /api/projects/{id} | — | {success} | unregister a project (cascade deletes all associated data) |
| PATCH | /api/projects/{id} | json | response | update project fields |
| GET | /api/projects/{id}/activity | — | result | project-wide activity feed (latest N events across all issues) |
| POST | /api/projects/{id}/archive | — | result | hide a project without deleting its data |
| GET | /api/projects/{id}/board | — | — | — |
| GET | /api/projects/{id}/board/summary | — | result | column counts only, no issue bodies |
| GET | /api/projects/{id}/branches | — | branches | — |
| GET | /api/projects/{id}/graph | — | — | — |
| GET | /api/projects/{id}/graph/search | — | — | matching, because the text never leaves the server. The client-side index this replaced MEASURED 364,380 gzipped bytes on this board — larger than the payload the ticket exists to shrink. An empty que |
| GET | /api/projects/{id}/onboarding | — | buildOnboardingPlan() | freshly imported project. Every step is derived from project/pref/issue state on read — only explicit skips and a dismissal timestamp are persisted (`onboarding_state_<id>`). GET /api/projects/:id/onb |
| POST | /api/projects/{id}/onboarding/apply | json | result | { stepId, input? } — applies the step (config write, plugin enable, or ticket filing) and returns the RECOMPUTED plan. |
| POST | /api/projects/{id}/onboarding/dismiss | json | dismissOnboarding() | stamps the plan dismissed (e.g. "close the wizard"); the plan itself stays queryable, just carries a dismissedAt. |
| POST | /api/projects/{id}/onboarding/skip | json | skipOnboardingStep() | { stepId } — records an explicit skip; never applied by an issue/plugin/config write. |
| POST | /api/projects/{id}/relocate | — | result | move one project to a new checkout path, rewriting every persisted path that pointed at the old one. `dryRun` reports the plan only. |
| GET | /api/projects/{id}/repos | — | map() | --- Multi-repo project repo set (additional repos; leading repo = project.repoPath) --- GET /api/projects/:id/repos |
| POST | /api/projects/{id}/repos | json | toProjectRepoResponse() | { path }       — an existing local git repo (absolute path) { cloneUrl }   — clone a remote repo into the server's repos dir { createName } — scaffold a NEW git repo (folder created inside the project |
| DELETE | /api/projects/{id}/repos/{repoId} | — | {success} | remove an additional repo from the set (does not touch the checkout on disk; existing workspaces keep their worktrees) |
| PATCH | /api/projects/{id}/repos/{repoId} | json | toProjectRepoResponse() | update a registered repo's per-repo setup/compose config (#71) |
| POST | /api/projects/{id}/repos/{repoId}/promote | — | {success} | make this sibling the project's LEADING repo, demoting the current leading into a sibling. Throws ProjectError (409 on open workspaces) via the domain error handler. |
| GET | /api/projects/{id}/stats | — | result | lightweight project stats |
| GET | /api/projects/{id}/statuses | — | result | — |
| POST | /api/projects/{id}/statuses | json | result | — |
| DELETE | /api/projects/{id}/statuses/{statusId} | — | result | — |
| PATCH | /api/projects/{id}/statuses/{statusId} | json | {success} | — |
| POST | /api/projects/{id}/unarchive | — | result | restore an archived project |
| GET | /api/projects/{id}/workspace-repo-status | — | — | (#415) — one batched request over all non-closed, non-direct workspaces, replacing the per-workspace {repo-merge-status, conflicts, handoff, diff} client fan-out. Body is memoized ~10s server-side; un |
| DELETE | /api/projects/{id}/worktrees | — | {success} | — |
| GET | /api/projects/{id}/worktrees | — | result | — |
| POST | /api/projects/{id}/worktrees/open | json | {success} | open a worktree folder in the OS file explorer |
| GET | /api/projects/all/workspaces | — | result | cross-project workspace summary (all projects) |
| POST | /api/projects/create | — | result | create a new directory as a git repo and register it |
| POST | /api/projects/generate-setup-script | json | {setupScript} | — |
| POST | /api/projects/generate-teardown-script | json | {teardownScript} | — |
| POST | /api/projects/generate-verify-script | json | {verifyScript} | — |
| GET | /api/projects/registration-progress/{id} | — | progress | flight (#388). The POST is what blocks, so progress has to travel on a second connection; the client mints the id, sends it with the POST, and polls this while it waits. Declared BEFORE `/:id` routes |
| POST | /api/projects/relocate-prefix | — | result | re-point every project under one directory at another (#964). Registered BEFORE the /:id routes so "relocate-prefix" is never matched as a project id. |

## quality-metrics

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/quality-metrics | — | result | — |
| POST | /api/projects/{id}/quality-metrics | CreateQualityMetricsRequest | result | — |
| GET | /api/projects/{id}/quality-metrics/latest | — | json | — |

## red-debt

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/red-debt | — | {entries} | list a project's red-debt ledger entries (open-only by default). |

## runbooks

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/runbooks | — | listRunbooks() | list available docs |
| GET | /api/projects/{id}/runbooks/content | — | runbook | read file content |

## scheduled-runs

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/scheduled-runs | — | list() | — |
| POST | /api/scheduled-runs | — | created | create |
| DELETE | /api/scheduled-runs/{id} | — | {ok} | — |
| PUT | /api/scheduled-runs/{id} | json | updated | update |
| POST | /api/scheduled-runs/{id}/run | — | {ok} | manual or scheduled trigger |

## sessions

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/sessions/{sessionId}/output | — | — | old shape (build the full body, hash it, then 304) still paid the whole read on every poll. `?tail=<bytes>` bounds the file read to the transcript tail (complete JSONL lines only), which is all the li |
| GET | /api/sessions/{sessionId}/stats | — | getStats() | — |
| GET | /api/sessions/{sessionId}/summary | — | getSummary() | — |
| GET | /api/sessions/search | — | json | — |

## tags

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/tags | — | listTags() | — |
| POST | /api/tags | json | result | — |
| DELETE | /api/tags/{id} | — | {success} | — |
| PATCH | /api/tags/{id} | {name?, color?} | result | — |
| POST | /api/tags/merge | json | {success} | merge sourceIds into targetId, then delete sources |

## tracker-snapshot

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/tracker-snapshot | — | snapshot | — |

## voice-capture

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/projects/{id}/voice-capture | json | result | Body: { transcript: string, speechLanguage?: string / null, speechLanguageLabel?: string / null } Creates a Backlog issue from a voice transcript using Claude to structure it. |

## workflows

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/workflows/analytics | — | result | — |
| GET | /api/workflows/analytics/{templateId}/{nodeId}/workspaces | — | data | — |
| GET | /api/workflows/resolve | — | data | — |
| GET | /api/workflows/templates | — | result | — |
| POST | /api/workflows/templates | {projectId?, name?, description?, ticketType?, isDefault?, …} | data | create a template (optionally cloning another). |
| DELETE | /api/workflows/templates/{id} | — | {ok} | delete a non-builtin template (cascade nodes/edges). |
| GET | /api/workflows/templates/{id} | — | data | full graph for one template. |
| PUT | /api/workflows/templates/{id} | {name?, description?, ticketType?, isDefault?, nodes?, …} | data | update a non-builtin template's graph in place. |
| GET | /api/workflows/templates/{id}/export | — | data | JSON envelope suitable for import. |
| POST | /api/workflows/templates/import | {projectId?} | data | import JSON as a new project template. |
| GET | /api/workflows/workspaces/{id}/progress | — | data | — |
| POST | /api/workflows/workspaces/{id}/transition | json | data | manual transition (UI-driven). |

## workspace-actions

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/workspaces/{id}/abort-rebase | — | abortRebase() | — |
| GET | /api/workspaces/{id}/already-merged-status | — | checkAlreadyMerged() | check if branch is already merged without modifying state ?adoptMainCheckout=true previews the #218 recovery override (work asserted to have landed on the base branch out-of-band) without acting on it |
| GET | /api/workspaces/{id}/artifacts | — | artifacts | list recognized artifacts in workspace directory |
| GET | /api/workspaces/{id}/artifacts-file | — | result | read a single artifact by ?path= query param |
| POST | /api/workspaces/{id}/bisect | {scope?} | startBisect() | — |
| GET | /api/workspaces/{id}/comments | — | listComments() | — |
| POST | /api/workspaces/{id}/comments | json | createComment() | — |
| DELETE | /api/workspaces/{id}/comments/{commentId} | — | {success} | — |
| PATCH | /api/workspaces/{id}/comments/{commentId} | json | updateComment() | — |
| PATCH | /api/workspaces/{id}/comments/{commentId}/resolve | json | resolveComment() | toggle resolved state |
| GET | /api/workspaces/{id}/conflicts | — | getConflicts() | — |
| GET | /api/workspaces/{id}/diff | — | — | — |
| POST | /api/workspaces/{id}/fix-and-merge | {mergeError?} | result | — |
| GET | /api/workspaces/{id}/github-handoff-draft | — | json | — |
| POST | /api/workspaces/{id}/github-handoff-draft | — | generateGithubHandoffDraft() | — |
| GET | /api/workspaces/{id}/handoff | — | getHandoff() | HANDOFF.md metadata (mtime + excerpt) per repo (#89) |
| GET | /api/workspaces/{id}/handoff-bundle | — | bundle | export a compact handoff bundle (JSON or Markdown) |
| POST | /api/workspaces/{id}/implement-plan | {planContent?} | implementPlan() | — |
| GET | /api/workspaces/{id}/latest-commit | — | getLatestCommit() | — |
| POST | /api/workspaces/{id}/launch | json | launchSession() | — |
| POST | /api/workspaces/{id}/merge | — | run | The default stays SYNCHRONOUS for back-compat — the UI and CLI both read the merge result from this response body today, and silently turning that into a 202 would make them report success for a merge |
| GET | /api/workspaces/{id}/merge-backoff | — | state | the persisted circuit-breaker state, so an operator can see WHY a workspace is being skipped before deciding to clear it. |
| POST | /api/workspaces/{id}/merge-backoff/clear | — | result | an operator door onto `clearMergeBackoff` (#1167). See `clearWorkspaceMergeBackoff` for why this exists. |
| DELETE | /api/workspaces/{id}/merge-hold | — | releaseWorkspaceMergeHold() | release the hold. A no-op (not an error) when the workspace was not held. |
| GET | /api/workspaces/{id}/merge-hold | — | getWorkspaceMergeHoldState() | current hold state, for the UI panel. |
| POST | /api/workspaces/{id}/merge-hold | json | placeWorkspaceMergeHold() | orchestrator, and the merge-train reconciler all skip it, WITHOUT disabling auto-merge for the rest of the project (#1164). Idempotent: re-holding an already-held workspace just updates the reason/tim |
| GET | /api/workspaces/{id}/merge-status | — | describeLiveMergeJob() | verdict (workspace_merge_gate) survives that restart, so when this process has no job the response says whether a PASSING verdict is stored — distinguishing "the gate failed" from "the gate passed and |
| POST | /api/workspaces/{id}/merge/cancel | json | cancelWorkspaceMerge() | stop THIS workspace's merge job (#1164). See `cancelWorkspaceMerge` above for what it does and why. |
| POST | /api/workspaces/{id}/open-editor | — | {ok} | — |
| GET | /api/workspaces/{id}/plan | — | getPlanContent() | — |
| POST | /api/workspaces/{id}/quarantine | — | quarantineWorkspace() | stop session + move issue back to In Progress |
| POST | /api/workspaces/{id}/reconcile-as-done | {adoptMainCheckout?} | reconcileAlreadyMerged() | Body `{ adoptMainCheckout: true }` (#218) is the explicit "the work landed on the base branch out-of-band" recovery — it overrides ONLY the "no unique commits" refusal, never the diff/ancestry/pending |
| POST | /api/workspaces/{id}/reject-plan | json | rejectPlan() | — |
| POST | /api/workspaces/{id}/reopen | — | reopenWorkspace() | (#1206) — re-create the worktree for a CLOSED workspace whose branch is still live and unmerged, unlike `/setup` above which only fills in a missing worktree for a workspace that is still OPEN. |
| GET | /api/workspaces/{id}/repo-merge-status | — | getRepoMergeStatus() | per-repo (leading + siblings) merge status (#70) |
| POST | /api/workspaces/{id}/repos/{repoName}/rebase | — | rebaseRepo() | per-repo recovery for a stranded sibling (#93): rebase ONE repo's worktree branch onto its base (REBASE only — never lands a repo in isolation). |
| POST | /api/workspaces/{id}/resolve-conflicts | — | result | — |
| POST | /api/workspaces/{id}/retry-cleanup | — | {success} | retry worktree cleanup for a workspace with a pending warning |
| POST | /api/workspaces/{id}/retry-setup | — | retrySetup() | (#1166) — re-runs the project's setup script in the workspace's EXISTING worktree and restamps the verdict, unlike `/setup` above which only recreates a missing worktree and no-ops when one is already |
| GET | /api/workspaces/{id}/scorecard | — | scorecard | — |
| POST | /api/workspaces/{id}/scorecard/refresh | — | scorecard | — |
| POST | /api/workspaces/{id}/services/down | — | {serviceState} | stop the stack (containers removed, named volumes kept so a subsequent start finds its data intact). |
| GET | /api/workspaces/{id}/services/logs | — | result | a bounded, non-following log tail. |
| POST | /api/workspaces/{id}/services/restart | — | {serviceState} | bounce the running containers. |
| POST | /api/workspaces/{id}/services/up | — | {serviceState} | host ports are preserved across start/stop/restart (no reallocation). POST /api/workspaces/:id/services/up — start (or, with ?recreate=true, rebuild) the stack; (re)provisions a deferred/errored/never |
| GET | /api/workspaces/{id}/sessions | — | getSessions() | — |
| POST | /api/workspaces/{id}/setup | — | setupWorkspace() | — |
| DELETE | /api/workspaces/{id}/stale-worktree | — | {success} | safely remove a stale worktree directory |
| POST | /api/workspaces/{id}/stop | — | stopWorkspace() | — |
| POST | /api/workspaces/{id}/terminal | — | {ok} | — |
| GET | /api/workspaces/{id}/timeline | — | timeline | session failure timeline with restart decisions |
| POST | /api/workspaces/{id}/turn | json | {sessionId, resumed} | The worker is therefore fast-forwarded FIRST, and the turn is REFUSED when that could not be done: a turn delivered into a stale checkout is worse than a refused one, and it is indistinguishable after |
| POST | /api/workspaces/{id}/update-base | json | updateBase() | — |
| GET | /api/workspaces/{id}/visual-proof | — | rows | list DB artifacts (visual proof) scoped to this workspace |

## workspaces

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/workspaces | — | {error} | flat project-scoped workspace list (slim: id/status/readyForMerge/issueId/branch/provider) GET /api/workspaces?issueId= — workspaces for a single issue (same shape, no join needed) Optional: status=ac |
| POST | /api/workspaces | {issueId?, issueNumber?, projectId?, branch?, isDirect?, …} | result | for the verdict. The default stays SYNCHRONOUS for back-compat — the UI, CLI, and MCP all read branch/workingDir from this response body today. |
| DELETE | /api/workspaces/{id} | — | {success} | cascade delete sessions and their messages |
| GET | /api/workspaces/{id} | — | details | — |
| PATCH | /api/workspaces/{id} | json | result | — |
| POST | /api/workspaces/{id}/close | — | result | close without merging (abandoned or already-merged work) |
| GET | /api/workspaces/{id}/dev-server-plan | — | result | URL / port + provenance) the board would boot for this workspace's project. The diagnostics tab renders this instead of assuming the app's own 3001/5173 worktree ports, which are wrong for any other p |
| POST | /api/workspaces/{id}/ready-for-merge | — | result | mark workspace as reviewed and ready to merge |
| GET | /api/workspaces/cleanup-warnings | — | warnings | list closed workspaces with pending cleanup warnings Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/cost-over-time | — | aggregateCostOverTime() | Complements provider-mix (share of work) by showing the cost *trend* over time. Cost is read from each session's persisted `stats.totalCostUsd`; the provider comes from the session's workspace. Must b |
| GET | /api/workspaces/create-jobs/{jobId} | — | {job} | creation started with `POST /api/workspaces?async=1`. `null` means this process has no record (unknown id, evicted, or the server restarted mid-create). Must be registered BEFORE /:id to avoid `create |
| POST | /api/workspaces/preview | {issueId?, issueNumber?, projectId?, branch?, isDirect?, …} | result | dry-run preview (read-only, no side effects) Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/provider-mix | — | aggregateProviderMix() | workspaces grouped by provider+profile per day Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/scorecard-distribution | — | bucketScorecardScores() | scorecard score histogram (5 buckets: 0-20, 20-40, 40-60, 60-80, 80-100) Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/stale-worktrees | — | staleWorktrees | list closed workspaces with directories still on disk Must be registered BEFORE /:id to avoid being matched as an ID param |

