---
generated: 2026-06-24T05:00:27.723Z
commit: 2ff9ce91922d4194666a35accff6eaa1c1cfefce
endpoints: 284
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
| POST | /api/projects/{id}/agent-questions/{toolUseId}/answer | {questions, answers, workspaceId} | {ok, sessionId, resumed, content} | Body: { questions: AgentQuestion[], answers: [{ selectedLabels: string[], freeText?: string }, ...], workspaceId: string } |
| POST | /api/projects/{id}/agent-questions/{toolUseId}/recommend | — | {ok, recommendations} | Useful for manual re-trigger and tests. The background path inside listAgentQuestions already fires recommendations automatically when none is cached, so a client usually does not need to call this. |

## agent-skills

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/agent-skills | — | listSkills() | list skills |
| POST | /api/agent-skills | {name, description, prompt, model?, projectId?} | skill | create a skill |
| DELETE | /api/agent-skills/{id} | — | {success} | — |
| GET | /api/agent-skills/{id} | — | getSkill() | get a single skill |
| PUT | /api/agent-skills/{id} | {name?, description?, prompt?, model?, projectId?} | updated | update a skill |
| POST | /api/agent-skills/{id}/install | — | installSkill() | — |
| GET | /api/agent-skills/{id}/install-status | — | getInstallStatus() | — |
| POST | /api/agent-skills/enhance | {name, description?, prompt?} | enhanceSkill() | AI-enhance a skill name, description, and prompt |
| GET | /api/agent-skills/install-status | — | getAllInstallStatuses() | batch install-status for all skills in one pass (registered before /:id so the static path wins over the :id param route). |

## approvals

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/approvals | {sessionId, toolName, toolInput} | {id} | Create a new approval request (called by MCP approve_tool_use tool) |
| DELETE | /api/approvals/{id} | — | {ok} | Clean up after MCP tool is done |
| GET | /api/approvals/{id} | — | {id, decision} | Get approval status (polled by MCP tool) |
| PUT | /api/approvals/{id} | {decision} | {ok} | Resolve approval (called by UI) |

## board-monitor

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/projects/{id}/conductor | — | {status} | Start/stop the out-of-process Conductor loop (dogfood board only). The Start Mode UI calls this when the user picks "conductor" (start) vs manual/monitor (stop). |
| GET | /api/projects/{id}/conductor-schedule | — | {available, schedule} | Cron schedule for the off-process Conductor (ticket #841). The continuous loop above is always-on; this drives one off-process cycle per scheduled tick instead. Config is a single per-project JSON pre |
| PUT | /api/projects/{id}/conductor-schedule | — | {available, schedule} | — |
| GET | /api/projects/{id}/monitor-tunables | — | {tunables, source, startPolicy} | — |
| GET | /api/projects/{id}/orchestrator | — | readOrchestratorStatus() | — |

## butler

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| DELETE | /api/projects/{id}/butler | — | {ok} | Clearing the persisted session id means the NEXT ensure starts a fresh session, which re-reads the (possibly customized) butler skill — so "stop butler" is how users apply skill/behavior changes. |
| GET | /api/projects/{id}/butler | — | {butlerId, backend, active, sessionId, contextTokens, …} | current butler state (for the selected ?butler=<id>) |
| POST | /api/projects/{id}/butler/ask | {content, timeoutMs?} | {sessionId, text, isError} | synchronous: send a turn, wait for the full answer, and return it in one response. This is the primitive used by the CLI and MCP tool (separate processes that cannot read the server's in-memory SSE st |
| GET | /api/projects/{id}/butler/commands | — | {commands} | Merges what the live SDK session reports with the repo's own .claude/skills/*/SKILL.md (so repo skills are always suggested, even before the SDK finishes discovery or for a project whose session isn't |
| POST | /api/projects/{id}/butler/ensure | — | {active, sessionId} | start the warm session if not running |
| POST | /api/projects/{id}/butler/interrupt | — | {ok} | stop the in-flight turn (keeps the session warm) |
| POST | /api/projects/{id}/butler/message | {content} | {ok} | send a turn to the warm session |
| GET | /api/projects/{id}/butler/messages | — | {messages} | conversation history for the active session, so the chat UI can restore prior messages after a page reload. |
| POST | /api/projects/{id}/butler/model | {model?} | {ok, model, applied} | restarting (preserves context, per the design). The model lives on the (global) butler definition, so this updates the definition and applies it live to the selected butler's warm session in this proj |
| POST | /api/projects/{id}/butler/profile | {profile?} | {ok, profile, active} | switch the Claude profile. A profile changes auth/endpoint, which cannot change mid-session, so this RESTARTS the butler fresh (forgets the resume id) per the design ("restart only where needed"). |
| GET | /api/projects/{id}/butler/profiles | — | {provider, profiles, selected, globalDefault} | available profiles + the butler's current selection ("" = inherit the global profile). |
| GET | /api/projects/{id}/butler/sessions | — | {sessions} | list recent butler sessions from disk JSONL |
| GET | /api/projects/{id}/butler/sessions/{sid}/messages | — | {messages} | transcript of a past session |
| GET | /api/projects/{id}/butler/skill | — | {prompt, isOverride} | the editable butler prompt + whether a project-scoped override exists (vs the global default). |
| PUT | /api/projects/{id}/butler/skill | {prompt} | {ok, isOverride} | upsert the project-scoped butler override. An empty prompt removes the override (revert to the global default). |
| GET | /api/projects/{id}/butler/stream | — | — | SSE stream of butler events |
| GET | /api/projects/{id}/butlers | — | {butlers} | all defined butlers + this project's per-butler runtime state (warm/cold, busy, context). Powers the butler switcher. |

## butler-definitions

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/butler-definitions | — | {butlers, max} | list defined butlers (always includes "default"). |
| POST | /api/butler-definitions | {name?, model?, provider?} | {butler} | create a named butler { name, model?, provider? }. |
| DELETE | /api/butler-definitions/{bid} | — | {ok} | remove a named butler ("default" is protected). |
| PUT | /api/butler-definitions/{bid} | {name?, model?, provider?} | {butler} | update name, model, and/or provider. |

## codemods

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/codemods | — | codemods | * GET /api/codemods?projectId=<id>    * Returns saved codemods (agent_skills with type='codemod') for a project. |
| POST | /api/codemods | {name, description, script, projectId?} | {type} | * POST /api/codemods    * Body: { name, description, script, projectId? }    * Save a codemod to agent_skills with type='codemod'. |
| GET | /api/codemods/{id} | — | skill | * GET /api/codemods/:id    * Returns a single saved codemod. |
| POST | /api/codemods/apply | {projectId, changes, selectedFiles?} | result | * POST /api/codemods/apply    * Body: { projectId: string, changes: [{filePath, modified}], selectedFiles?: string[] }    * Returns: { applied: string[], skipped: string[] }    *    * `projectId` |
| POST | /api/codemods/preview | {description, projectId, overrideLimit?, script?} | {script, description, files, totalTsFiles, limitReached} | * POST /api/codemods/preview    * Body: { description: string, projectId: string, overrideLimit?: boolean, script?: string }    * Returns: { script, description, files: [{filePath, relativePath, dif |

## config-export-import

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/config/export | — | — | — |
| POST | /api/projects/{projectId}/config/import | — | {ok, statusChanges, prefChanges, strategyChanged, droppedKeys} | — |

## digest

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/digest | — | response | `now` is injectable for deterministic time-window tests (nowOverride pattern). |

## drive

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/drive | — | getDriveStatus() | — |
| PUT | /api/projects/{projectId}/drive | {enabled?} | setDriveEnabled() | — |
| GET | /api/projects/{projectId}/drive/preflight | — | runDrivePreflight() | — |
| POST | /api/projects/{projectId}/drive/preflight | {autoRepair?} | runDrivePreflight() | — |

## drive-obstacles

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/drive-obstacles | — | map() | queryable log |
| POST | /api/projects/{projectId}/drive-obstacles | {driveId?, kind?, severity?, issueNumber?, summary?, …} | {id} | record one obstacle |
| GET | /api/projects/{projectId}/drive-obstacles/summary | — | {total, byKind} | per-kind breakdown for the dashboard |

## drives

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/drives | — | list() | — |
| POST | /api/projects/{projectId}/drives | {metaIssueId?, target, completionContract?} | result | starts a drive |
| DELETE | /api/projects/{projectId}/drives/{id} | — | {success} | — |
| GET | /api/projects/{projectId}/drives/{id} | — | get() | — |
| PUT | /api/projects/{projectId}/drives/{id} | json | result | — |
| GET | /api/projects/{projectId}/drives/{id}/dashboard | — | dashboard | aggregated drive view (#800) |
| POST | /api/projects/{projectId}/drives/{id}/finish | {status?} | result | — |
| GET | /api/projects/{projectId}/drives/{id}/review-effectiveness | — | {drive} | Per-drive AI code-review effectiveness: reviews run, reviews that bounced a ticket back to building, and merged-without-review — scoped to the drive's time window and (unless ?wholeProject=true) the m |

## flaky-tests

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/flaky-tests | — | flaky | list flaky tests |
| POST | /api/flaky-tests/parse | json | {inserted} | ingest test output JSON |
| DELETE | /api/flaky-tests/pin | — | {ok} | unpin a test |
| POST | /api/flaky-tests/pin | json | {ok} | pin a test as known-flaky |
| GET | /api/flaky-tests/pinned | — | getPinnedTests() | list pinned (known-flaky) tests |

## focus

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/focus | — | response | `now` is accepted for parity with the digest route and deterministic tests; the focus ranking itself is point-in-time, not windowed. |

## health

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/health | — | {status, ok, checks} | still listening, so a naive "status: ok" probe stays green while every DB-backed API route fails with ERR_MODULE_NOT_FOUND. Reporting "degraded" here lets monitors detect a board that is up but unusab |
| GET | /api/health/deps | — | result | — |

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
| GET | /api/issues | — | result | slim=1 omits the description field (the bulk of the payload) — opt-in, default response shape unchanged. |
| POST | /api/issues | {projectId, title, description?, priority?, issueType?, …} | result | — |
| DELETE | /api/issues/{id} | — | {success} | — |
| GET | /api/issues/{id} | — | result | — |
| PATCH | /api/issues/{id} | json | result | — |
| GET | /api/issues/{id}/activity | — | result | chronological audit feed aggregated from workspaces/sessions/comments |
| POST | /api/issues/{id}/analyze-touched-files | {refresh?} | analyzeTouchedFiles() | run (or re-run) AI prediction |
| GET | /api/issues/{id}/artifacts | — | getArtifacts() | — |
| POST | /api/issues/{id}/artifacts | {type, mimeType?, content, caption?, workspaceId?} | {id} | — |
| DELETE | /api/issues/{id}/artifacts/{artifactId} | — | {success} | — |
| GET | /api/issues/{id}/comments | — | {comments} | durable Q&A / activity thread for an issue |
| POST | /api/issues/{id}/comments | {kind?, author?, body?, payload?, workspaceId?} | comment | — |
| DELETE | /api/issues/{id}/comments/{commentId} | — | {success} | — |
| GET | /api/issues/{id}/cycle-time | — | result | per-status time aggregation derived from workflow transitions |
| POST | /api/issues/{id}/decompose | {projectId} | decomposeEpic() | AI-generate epic decomposition proposal |
| POST | /api/issues/{id}/decompose/confirm | {projectId, children, dependencies, driveTarget?} | result | confirm epic decomposition and create child issues |
| GET | /api/issues/{id}/dependencies | — | getDependencies() | — |
| POST | /api/issues/{id}/dependencies | {dependsOnId, type?} | {id, type} | — |
| DELETE | /api/issues/{id}/dependencies/{depId} | — | {success} | — |
| GET | /api/issues/{id}/detail-bundle | — | {issue, workspaces, tags, dependencies, artifacts, …} | milestones, available issues) and git-heavy best-effort data (touched-files, related-issues, merged-commits) stay on their own endpoints. Each sub-result is independent: a failure degrades that field |
| POST | /api/issues/{id}/duplicate | — | result | — |
| GET | /api/issues/{id}/merged-commits | — | result | commits that landed on the default branch for this issue |
| POST | /api/issues/{id}/preflight | {projectId, clarifications?} | {clarificationsBlock} | persisted as a durable `preflight-clarification` comment and folded into the prompt for the re-check. The returned `clarificationsBlock` is the markdown the caller can prepend to the launching agent's |
| GET | /api/issues/{id}/related-issues | — | {related} | find other issues that share touched files with this one |
| GET | /api/issues/{id}/showdown | — | json | Returns 200 with `null` when none exists: most issues never have a showdown, so "no showdown" is a normal state, not a client error. (A 404 here floods the browser console with errors every time an is |
| POST | /api/issues/{id}/showdown | {contestants} | {error} | start a showdown with N contestants |
| GET | /api/issues/{id}/summary | — | result | — |
| GET | /api/issues/{id}/tags | — | getTags() | — |
| POST | /api/issues/{id}/tags | {tagId} | result | — |
| DELETE | /api/issues/{id}/tags/{tagId} | — | {success} | — |
| GET | /api/issues/{id}/time-entries | — | {entries, totalMinutes} | — |
| POST | /api/issues/{id}/time-entries | {minutes?, note?} | entry | — |
| DELETE | /api/issues/{id}/time-entries/{entryId} | — | {success} | — |
| GET | /api/issues/{id}/touched-files | — | {files, cached} | return cached prediction only (no AI call) |
| GET | /api/issues/{id}/workspaces | — | getEnrichedWorkspaces() | — |
| POST | /api/issues/ai-estimate | {issueId} | aiEstimateIssue() | AI-suggest a T-shirt size estimate for an issue |
| POST | /api/issues/analyze-dependencies | {issueId, projectId} | result | AI-analyze dependencies for an issue |
| POST | /api/issues/archive-done | {projectId?, olderThanDays?, nowOverride?} | {archived} | move Done issues older than N days to Archived |
| POST | /api/issues/batch | {projectId, issues, parentIssueId?, driveTarget?} | result | create N issues atomically Optional: parentIssueId wires child_of edges; driveTarget (requires parentIssueId) auto-creates a Drive record. |
| PATCH | /api/issues/bulk | {issueIds?, updates?} | {updated} | update N issues in one request |
| GET | /api/issues/burndown | — | getBurndownChart() | createdAt + current status + statusChangedAt). Registered before the `/:id` catch-all: literal sub-paths must precede it or Hono's order-sensitive router (fallback for this router's nested params) sha |
| GET | /api/issues/cfd | — | getCfdChart() | Returns one entry per (date, status) pair: the count of issues that were in that status as of the end of that day (based on statusChangedAt or createdAt when no explicit status change is recorded). |
| POST | /api/issues/dependencies/batch | {edges} | {added, removed, skipped} | add/remove N dependency edges atomically |
| POST | /api/issues/enhance | {title, description?, projectId?} | enhanceIssue() | AI-enhance a ticket title and description |
| GET | /api/issues/lead-time | — | getLeadTimeChart() | lead time trend: median + p90 per day for issues that reached Done. Lead time = Done statusChangedAt - createdAt (wall-clock age of the issue). Returns one bucket per day in the trailing window; bucke |
| GET | /api/issues/throughput | — | getThroughputChart() | daily throughput: count of issues moved to Done per calendar day. Uses statusChangedAt to identify when issues entered the Done status. Returns one data point per day for the trailing `days` window (d |

## merge-queue

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/merge-queue | {workspaceIds?, dryRun?, skipOnConflict?} | {ok, dryRun, plan} | * POST /api/merge-queue    *    * body: { workspaceIds: string[], dryRun?: boolean, skipOnConflict?: boolean }    *    * - dryRun: true  → returns JSON plan (sorted order + conflict matrix + per-w |
| POST | /api/merge-queue/preview/{workspaceId} | — | {ok, preview} | * POST /api/merge-queue/preview/:workspaceId    *    * Dry-run conflict preview for a single workspace. Read-only — does not mutate the worktree.    * Returns: WorkspaceConflictPreview |

## metrics

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/metrics/slow-requests | — | {entries} | — |

## milestones

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/milestones | — | list() | — |
| POST | /api/projects/{projectId}/milestones | {name, dueDate?} | result | — |
| DELETE | /api/projects/{projectId}/milestones/{id} | — | {error} | — |
| PUT | /api/projects/{projectId}/milestones/{id} | {name?, dueDate?} | {error} | — |
| GET | /api/projects/{projectId}/milestones/summary | — | summary() | — |

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
| GET | /api/preferences/home-dir | — | {homeDir, sep} | so the client can infer a Codex license's default CODEX_HOME (`<home>/.codex-<profile>`) without re-implementing path joins. |
| GET | /api/preferences/mcp/health | — | getMcpHealthSummary() | — |
| POST | /api/preferences/mcp/probe | — | probeMcpHealth() | — |
| GET | /api/preferences/pi-profiles | — | {profiles} | — |
| GET | /api/preferences/provider-divergence | — | getProviderDivergence() | Returns whether the global provider/profile prefs diverge from the project's Strategy Bullseye. The Bullseye is the single source of truth for workspace creation and the butler; divergence means the S |
| GET | /api/preferences/quota-usage | — | data | live quota from tampermonkey-direct |
| GET | /api/preferences/settings | — | getSettings() | get all agent settings |
| PUT | /api/preferences/settings | Record<string, string> | {ok, applied} | dropped keys — so a mistyped / un-registered setting fails loudly instead of silently no-op'ing the way auto_rebase_on_continue and skip_preflight once did (#874). |
| GET | /api/preferences/settings-bootstrap | — | {settings, claudeProfiles, codexProfiles, copilotProfiles, piProfiles, …} | the browser's ~6-connection per-host HTTP/1.1 cap (which was queuing the requests to ~1.2s). The heavy/secondary probes — agent-profile health (~600ms), mcp health, install-status, branches — stay sep |

## project-scripts

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{projectId}/scripts | — | list() | — |
| POST | /api/projects/{projectId}/scripts | json | create() | — |
| DELETE | /api/projects/{projectId}/scripts/{scriptId} | — | {success} | — |
| PATCH | /api/projects/{projectId}/scripts/{scriptId} | json | update() | — |
| POST | /api/projects/{projectId}/scripts/{scriptId}/run | — | — | — |

## projects

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects | — | result | (?includeArchived=true to include archived projects) |
| POST | /api/projects | {repoPath, name?, description?, color?, gitignoreTemplate?, …} | result | — |
| DELETE | /api/projects/{id} | — | {success} | unregister a project (cascade deletes all associated data) |
| PATCH | /api/projects/{id} | json | result | update project fields |
| GET | /api/projects/{id}/activity | — | result | project-wide activity feed (latest N events across all issues) |
| POST | /api/projects/{id}/archive | — | result | hide a project without deleting its data |
| GET | /api/projects/{id}/board | — | — | — |
| GET | /api/projects/{id}/board-health-events | — | map() | — |
| GET | /api/projects/{id}/board-health-events/{eventId} | — | toBoardHealthEventDetail() | full event details (not compacted) |
| GET | /api/projects/{id}/board-risk-digest | — | digest | — |
| GET | /api/projects/{id}/board/summary | — | result | column counts only, no issue bodies |
| GET | /api/projects/{id}/branches | — | branches | — |
| POST | /api/projects/{id}/check-overlap | {issueIds} | checkIssueOverlap() | check for file overlap between issues using cached predictions |
| GET | /api/projects/{id}/dashboard/throughput-by-provider | — | computeThroughputByProvider() | Rank providers/profiles by issues merged to master within a selectable time window. Returns count + median lead time per provider. |
| GET | /api/projects/{id}/dependency-waves | — | result | — |
| POST | /api/projects/{id}/dependency-waves/start-next | — | result | — |
| GET | /api/projects/{id}/file-contention | — | result | live file contention heatmap for active/reviewing workspaces |
| GET | /api/projects/{id}/graph | — | result | — |
| GET | /api/projects/{id}/monitor-cycles | — | cycles | aggregated cycle summaries |
| GET | /api/projects/{id}/sprint-capacity | — | result | — |
| GET | /api/projects/{id}/stack-profile | — | {projectId, profile} | the durable per-project stack descriptor (#786). Returns the persisted profile; computes+persists one on demand if absent (?refresh=true forces a recompute). The feedback harness reads this ONE descri |
| PUT | /api/projects/{id}/stack-profile | Partial<StackProfile> | {projectId, profile} | override the stack profile from the UI. Marks the saved profile source="manual" so a later auto-detect won't silently clobber it. |
| GET | /api/projects/{id}/stats | — | result | lightweight project stats |
| GET | /api/projects/{id}/statuses | — | result | — |
| POST | /api/projects/{id}/statuses | {name, sortOrder?} | result | — |
| DELETE | /api/projects/{id}/statuses/{statusId} | — | result | — |
| PATCH | /api/projects/{id}/statuses/{statusId} | json | {success} | — |
| POST | /api/projects/{id}/unarchive | — | result | restore an archived project |
| GET | /api/projects/{id}/workspace-launch-failures | — | result | — |
| GET | /api/projects/{id}/workspace-risk | — | result | risk heatmap for active/review workspaces |
| DELETE | /api/projects/{id}/worktrees | — | {success} | — |
| GET | /api/projects/{id}/worktrees | — | result | — |
| POST | /api/projects/{id}/worktrees/open | {path} | {success} | open a worktree folder in the OS file explorer |
| GET | /api/projects/all/workspaces | — | result | cross-project workspace summary (all projects) |
| POST | /api/projects/create | {name, path?, description?, color?, gitignoreTemplate?, …} | result | create a new directory as a git repo and register it |
| POST | /api/projects/generate-setup-script | {projectId?} | {setupScript} | — |
| POST | /api/projects/generate-teardown-script | {projectId?} | {teardownScript} | — |
| POST | /api/projects/generate-verify-script | {projectId?} | {verifyScript} | — |
| GET | /api/projects/health | — | result | aggregated health overview for all registered projects |

## quality-metrics

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/quality-metrics | — | result | — |
| POST | /api/projects/{id}/quality-metrics | CreateQualityMetricsRequest | result | — |
| GET | /api/projects/{id}/quality-metrics/latest | — | json | — |

## runbooks

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/runbooks | — | entries | list available docs |
| GET | /api/projects/{id}/runbooks/content | — | {path, title, lastModified, content} | read file content |

## scheduled-runs

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/scheduled-runs | — | list() | — |
| POST | /api/scheduled-runs | {name, projectId, description?, prompt?, skillId?, …} | created | create |
| DELETE | /api/scheduled-runs/{id} | — | {ok} | — |
| PUT | /api/scheduled-runs/{id} | json | updated | update |
| POST | /api/scheduled-runs/{id}/run | — | {ok} | manual or scheduled trigger |

## sessions

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/sessions/{sessionId}/output | — | — | — |
| GET | /api/sessions/{sessionId}/stats | — | getStats() | — |
| GET | /api/sessions/{sessionId}/summary | — | getSummary() | — |
| GET | /api/sessions/search | — | json | — |

## showdowns

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/showdowns/{id} | — | result | — |
| POST | /api/showdowns/{id}/pick-winner | {winnerWorkspaceId} | {error} | — |

## tags

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/tags | — | listTags() | — |
| POST | /api/tags | {name?, color?} | result | — |
| DELETE | /api/tags/{id} | — | {success} | — |
| PATCH | /api/tags/{id} | {name?, color?} | result | — |
| POST | /api/tags/merge | json | {success} | merge sourceIds into targetId, then delete sources |

## time-report

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/projects/{id}/time-report | — | response | — |

## voice-capture

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| POST | /api/projects/{id}/voice-capture | {transcript, speechLanguage?, speechLanguageLabel?} | result | Body: { transcript: string, speechLanguage?: string / null, speechLanguageLabel?: string / null } Creates a Backlog issue from a voice transcript using Claude to structure it. |

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
| GET | /api/workspaces/{id}/already-merged-status | — | checkAlreadyMerged() | check if branch is already merged without modifying state |
| GET | /api/workspaces/{id}/artifacts | — | artifacts | list recognized artifacts in workspace directory |
| GET | /api/workspaces/{id}/artifacts-file | — | result | read a single artifact by ?path= query param |
| POST | /api/workspaces/{id}/bisect | {scope?} | startBisect() | — |
| GET | /api/workspaces/{id}/comments | — | listComments() | — |
| POST | /api/workspaces/{id}/comments | {filePath, body, lineNumOld?, lineNumNew?, side?} | createComment() | — |
| DELETE | /api/workspaces/{id}/comments/{commentId} | — | {success} | — |
| PATCH | /api/workspaces/{id}/comments/{commentId} | {body?} | updateComment() | — |
| PATCH | /api/workspaces/{id}/comments/{commentId}/resolve | json | resolveComment() | toggle resolved state |
| GET | /api/workspaces/{id}/conflicts | — | getConflicts() | — |
| GET | /api/workspaces/{id}/diff | — | — | — |
| POST | /api/workspaces/{id}/fix-and-merge | {mergeError?} | result | — |
| GET | /api/workspaces/{id}/github-handoff-draft | — | json | — |
| POST | /api/workspaces/{id}/github-handoff-draft | — | generateGithubHandoffDraft() | — |
| GET | /api/workspaces/{id}/handoff-bundle | — | bundle | export a compact handoff bundle (JSON or Markdown) |
| POST | /api/workspaces/{id}/implement-plan | {planContent?} | implementPlan() | — |
| GET | /api/workspaces/{id}/latest-commit | — | getLatestCommit() | — |
| POST | /api/workspaces/{id}/launch | json | launchSession() | — |
| POST | /api/workspaces/{id}/merge | — | mergeWorkspaceDeduped() | — |
| POST | /api/workspaces/{id}/open-editor | — | {ok} | — |
| GET | /api/workspaces/{id}/plan | — | getPlanContent() | — |
| POST | /api/workspaces/{id}/quarantine | — | quarantineWorkspace() | stop session + move issue back to In Progress |
| POST | /api/workspaces/{id}/reconcile-as-done | — | reconcileAlreadyMerged() | close a workspace whose branch is already on master |
| POST | /api/workspaces/{id}/reject-plan | json | rejectPlan() | — |
| POST | /api/workspaces/{id}/resolve-conflicts | — | result | — |
| POST | /api/workspaces/{id}/retry-cleanup | — | {success} | retry worktree cleanup for a workspace with a pending warning |
| GET | /api/workspaces/{id}/scorecard | — | scorecard | — |
| POST | /api/workspaces/{id}/scorecard/refresh | — | scorecard | — |
| GET | /api/workspaces/{id}/sessions | — | getSessions() | — |
| POST | /api/workspaces/{id}/setup | — | setupWorkspace() | — |
| DELETE | /api/workspaces/{id}/stale-worktree | — | {success} | safely remove a stale worktree directory |
| POST | /api/workspaces/{id}/stop | — | stopWorkspace() | — |
| POST | /api/workspaces/{id}/terminal | — | {ok} | — |
| GET | /api/workspaces/{id}/timeline | — | timeline | session failure timeline with restart decisions |
| POST | /api/workspaces/{id}/turn | {content?} | {sessionId, resumed} | — |
| POST | /api/workspaces/{id}/update-base | json | updateBase() | — |
| GET | /api/workspaces/{id}/visual-proof | — | rows | list DB artifacts (visual proof) scoped to this workspace |

## workspaces

| Method | Path | Request | Response | Description |
| --- | --- | --- | --- | --- |
| GET | /api/workspaces | — | rows | flat project-scoped workspace list (slim: id/status/readyForMerge/issueId/branch/provider) GET /api/workspaces?issueId= — workspaces for a single issue (same shape, no join needed) Optional: status=ac |
| POST | /api/workspaces | {issueId?, branch?, isDirect?, baseBranch?, requiresReview?, …} | result | create workspace with worktree + auto-launch agent |
| DELETE | /api/workspaces/{id} | — | {success} | cascade delete sessions and their messages |
| GET | /api/workspaces/{id} | — | details | — |
| PATCH | /api/workspaces/{id} | json | result | — |
| POST | /api/workspaces/{id}/close | — | result | close without merging (abandoned or already-merged work) |
| POST | /api/workspaces/{id}/ready-for-merge | — | result | mark workspace as reviewed and ready to merge |
| GET | /api/workspaces/cleanup-warnings | — | warnings | list closed workspaces with pending cleanup warnings Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/cost-over-time | — | aggregateCostOverTime() | Complements provider-mix (share of work) by showing the cost *trend* over time. Cost is read from each session's persisted `stats.totalCostUsd`; the provider comes from the session's workspace. Must b |
| POST | /api/workspaces/preview | {issueId?, branch?, isDirect?, baseBranch?, requiresReview?, …} | result | dry-run preview (read-only, no side effects) Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/provider-mix | — | aggregateProviderMix() | workspaces grouped by provider+profile per day Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/scorecard-distribution | — | bucketScorecardScores() | scorecard score histogram (5 buckets: 0-20, 20-40, 40-60, 60-80, 80-100) Must be registered BEFORE /:id to avoid being matched as an ID param |
| GET | /api/workspaces/stale-worktrees | — | staleWorktrees | list closed workspaces with directories still on disk Must be registered BEFORE /:id to avoid being matched as an ID param |

