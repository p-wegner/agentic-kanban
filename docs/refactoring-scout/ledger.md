# refactoring-scout ledger

Loop state for the `refactoring-scout` skill (`.claude/skills/refactoring-scout/SKILL.md`). A round
that is not logged here gets planned again. Read the **Lanes** table + the freshness gate in the
skill before planning a run; read **Filed** and **Rejected** as the exclusion list for scouts.

Two clocks per lane: **Last full sha** (full-lane scan; the reopen gate compares against it) and **Last diff sha** (drift-scoped scan of changed files only). Ticket-freshness passes are logged per round.

Harvest signals are numbered as in the skill (1 markers, 2 type/string sniffing, 3 guard chains,
4 copy-drifted helpers, 5 enum-by-if, 6 flag soup, 7 re-derivation, 8 ad-hoc persistence, 9 test
smells, 10 layer copies, 11 SSOT-declared-but-bypassed, 12 low-adoption helper, 13 positional
relays, 14 lifecycle boilerplate, 15 sentinel values, 16 live-vs-recovery path, 17 same-inputs-two-builders,
18 cross-package vocab/DTO drift).

## Lanes

| Lane | Paths | Last full sha | Last diff sha | Model | Signals run | Last yield (filed / rejected) | Status |
|---|---|---|---|---|---|---|---|
| whole-repo | `packages/*/src` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 | 12 / ~20 (two identical scouts, ~40% overlap) | saturated for this model unless drift |
| server-services | `packages/server/src/services/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 (+11–13 de facto) | 8 / 11 | one focused pass; healthy yield |
| client | `packages/client/src/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 (+12,14 de facto) | 8 / 9 | one focused pass; healthy yield |
| mcp-cli-routes | `packages/mcp-server/src/**`, `packages/server/src/{cli,routes,lib}/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 | 8 / 9 | one focused pass; healthy yield |
| shared-startup-repos | `packages/shared/src/**`, `packages/server/src/{startup,db,repositories}/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 (+11,15 de facto) | 7 / 15 | one focused pass; healthy yield |
| startup-decisions + session-manager + agent-provider | `packages/server/src/startup/**` (decision logic, not timers), `services/session-manager/**`, `services/agent-provider/**` | `37172a4485` (2026-08-16) | — | claude-fable-5 | 1–15 (16/17 de facto) | 10 / 14 (+3 user-visible bugs) | one focused pass; healthy yield |
| extension-subsystems | plugin* services, `shared/lib/plugin-manifest.ts`, ticket-context, worker-*/agent-remote/git-http, workspace-services*/devcontainer*/container-wrap/port-allocator, agent-skills materialization | `37172a4485` (2026-08-16) | — | claude-fable-5 | 1–15 (17 de facto) | 8 / 14 (+3 user-visible bugs) | one focused pass; healthy yield |
| test-seams | `packages/*/__tests__/**`, `packages/e2e/**` (as evidence for production seams) | `37172a4485` (2026-08-16) | — | claude-fable-5 | 9 (sub-signals) | 8+1 / 14 | one pass; mock histogram at sha: git.service 35, db/index 61, butler-event-feed 13, review-helpers 8, boardEvents-as-never 17, sessionManager-as-never 17 |
| types-contracts | `shared/src/{types,schema}` vs client/server/mcp/cli declared types & route payloads | `37172a4485` (2026-08-16) | — | claude-fable-5 | 2 (scoped), 5, 11, 12, 18 | 7 / 10 (+2 user-visible bugs) | one pass; client∩server∖shared type names = 90 at sha |

## Rounds

### Round 1 — 2026-08-16 — HEAD `aad29dcaee` — claude-fable-5
Two identical whole-repo scouts (A, B), skill v1 (signals 1–10). 7 + 8 findings; 3 identical, 2
overlapping → **12 tickets #493–#504**.

### Round 2 — 2026-08-16 — HEAD `aad29dcaee` — claude-fable-5
Four focused lanes (C server-services, D client, E mcp-cli-routes, F shared-startup-repos) with the
round-1 exclusion list. 8 + 8 + 8 + 7 findings; one cross-lane duplicate (C1 ≡ F3) → **30 tickets
#505–#534**. Skill v2 afterwards added signals 11–15, the ledger/freshness gate, fleet playbook,
REST filing fallback, latent-bug flagging.

### Round 3 — 2026-08-16 — HEAD `37172a4485` — claude-fable-5
Four NEW lanes on unchanged code (G startup-decisions+session-manager+agent-provider, H
extension-subsystems, I test-seams, J types-contracts), skill v2, ledger as exclusion list.
10 + 8 + 8(+1 cross-lane) + 7 findings, 0 cross-lane duplicates → **34 refactor tickets #539–#572**
+ **8 bug tickets #573–#580** split out per the new split rule (user-visible impact). Ticket-
freshness pass: not needed (all tickets filed today at the same sha). Skill v3 afterwards: signals
16–18, signal-9 sub-signals + mock-histogram command, scoped signal 2, bag variant of 6, unexported
variant of 12, docs-check + `git log -S` in Step 2, bug split rule, guard+batch = one ticket,
per-lane signal yield notes, Sibling-evidence section.

## Filed (exclusion list — skip anything that is the same idea; reference the ticket instead)

Round 1:
- #493 client provider if-ladders → `PROVIDER_TRAITS` table (settings-shared, workspace-helpers, QuickTasksPanel, CreateWorkspaceForm, profileOptionLabels…); provider-profile list fan-out (`Promise.all` of `*-profiles`) belongs here too
- #494 `loadPrefMap()`: hand-built `new Map(rows.map(...))` pref maps + duplicate `getAllPreferences` in repositories
- #495 session `triggerType` typed vocabulary / `classifyTrigger` / `isBuilderSession` copies / trigger label maps
- #496 `projectPref(prefix)` builder+parser for `<prefix>_<projectId>` keys, inverse regexes, `PROJECT_SCOPED_KEY_PREFIXES`; `plugin_enabled_<slug>_<id>` slice-parse and `auto_merge_disabled_<id>` set-builders are siblings
- #497 `board_strategy` read+parse copies → `readStrategyBullseye`; `resolveMonitorTunables` fallback drift
- #498 workspace liveness status sets ({active,fixing} etc.) → `isAgentRunningStatus`/`occupiesWipSlot`
- #499 board server port/URL resolution copies in CLI + MCP (`KANBAN_SERVER_PORT ?? 3001`, `getServerPort`, `api()`)
- #500 butler backend resolver: `routes/butler.ts resolveButlerBackend` + `recommendation.ts` + `plugin-gate-butler.service.ts` copies
- #501 MCP raw issue-status writers (`update-issue.ts`, `contract-coupled-issues.ts`) → `transitionIssueStatus`
- #502 duplicate repository primitives `getWorkspaceById`/`getIssueProjectId`/`getTerminalStatusIds`/`getProjectDefaultBranch`; `resolveRepoPath` ×3, `getWorkspaceIdsForIssue`/`getSessionStdoutMessages`/`insertIssueDependency` ×2 are evidence for it
- #503 executor-id ↔ provider-name mapping (`toExecutorProvider`, `followup-workspace.service.ts` ternary — carries a bug: copilot/pi follow-ups launch Claude)
- #504 client copy of `cron-utils`

Round 2:
- #505 CLI `cliAction()` wrapper (`runMigrations` + catch/exit boilerplate, `printJsonOrSummary`)
- #506 `loadIssueSummary` in shared (REST/CLI/MCP issue→workspace→session→summary chain)
- #507 `readSessionMessages` (.out file else `session_messages` fork, 11 sites)
- #508 MCP `boardApi()`/`mcpJson()`/error envelope (raw fetch in 28 tools, private `api()` copies, `mcpStructuredError` drift, `resolveActiveProjectId` copies)
- #509 `resolveIssueRef` + CLI `requireIssueByNumber` prelude (numeric-or-uuid lookups, `describeIssueNumberMiss`)
- #510 `domainErrorHandler` residual route try/catch + `requireProject(id)` preludes
- #511 `queryInt`/`queryFlag` query-param coercion
- #512 `parseJsonBody` zod overload / `is required` guards
- #513 client `useApiResource` / fetch-in-effect ladders (`let cancelled`, `retryKey`, "Failed to load")
- #514 `useBoardWsRefresh` (`BOARD_WS_EVENT` filter+debounce+refetch copies)
- #515 `useDismissable` (outside-click + Escape effects)
- #516 `PRIORITY_TRAITS` (client priority ladders, phantom `urgent`) / issue-type ladders
- #517 `WORKSPACE_STATUS_TONE` / `ISSUE_STATUS_TONE` badge tables (`badgeTones`)
- #518 `usePoll`/`useNow` via `pollScheduler` (raw setInterval pollers, `Date.now` tickers, `useBoardEvents` visibility copy)
- #519 `apiFetchConditional` ETag/304 transport copies
- #520 client copies of `isResolvedDependencyStatusView` / `RESOLVED_STATUS_NAMES`
- #521 stack fallback marker ladders (`deriveInstallFromMarkers`, `deriveVerifyScript`) → `detectStackProfile`; `detectNodePackageManager` ×3
- #522 `sessions.stats` blob typing (`SessionStatsBlob`, `readSessionStats`, `mergeExistingStats` copies, `isZeroOutputSession` ×2)
- #523 `DEPENDENCY_TYPE_TRAITS` + `findCycleNodes` (`BLOCKING_DEPENDENCY_TYPES` copies, `findCycleIssueIds` ×2)
- #524 `AgentExecutionService.launch` positional params → `AgentLaunchRequest` + `prepareAgentLaunch` (host/remote prep dup; carries a bug: codex context files dropped on remote placement)
- #525 `isInsideManagedWorktreesRoot` (`.worktrees` containment guard ×3)
- #526 provider adapters mock-agent preamble / `parseStreamEvent` boilerplate (`resolveMockLaunch`, `BaseProvider`)
- #527 `errorMessage(err)` helper (`err instanceof Error ? … ` ×455)
- #528 `claudeProfile` deprecated carrier → `profile: ProfileSelection` only
- #529 `startPeriodicSweep` (reconciler start/stop timer boilerplate, enabled-pref reads)
- #530 `resolveDiffRef` / `diffRangeArgs` (`isDirect ? "HEAD" : baseBranch` copies; `getDiff` HEAD sentinel; `detectConflicts` merge-tree parse dup)
- #531 `serviceState`/`servicesConfig` JSON codecs (`parseServicesConfig` ×2 etc.)
- #532 `pathKey`/`samePath` Windows path equality
- #533 issue-number allocator + UNIQUE sniff to shared; shared `*Db` type aliases ×6; `DbOrTx` ×4
- #534 `json-narrow` helpers (`agent-stream/shared.ts` copies, `isRecord`/`asRecord` private copies, dead `copilot-event-extractors`)

Round 3:
- #539 `getCommitCountAhead(headRef)` + `workspaceHasCommittedWork()` (3 `rev-list --count` copies; sibling-blind readers in session-restore/completion-state/stranded-review)
- #540 `runGateWithEvidence()` (#243 pin/re-resolve protocol copied in merge-gate + exit-workflow, skipped in monitor-cycle) — bug #573
- #541 `resolveWorkspaceLaunchSettings()` (5 sub-session launch ladders; review.service `buildReviewArgs`/`parseProviderPref`/`getEffectiveProfile` copies; `waitForLearningSession` ×2)
- #542 `readUsageLimitStats`/`buildUsageLimitStats` keyed on `rateLimitKind` (codex/claude predicate pairs, Codex-only readers in monitor-cycle) — slice of #522
- #543 `finalizeExitRoute` + `teardownSessionState` (live vs `notifyExternalExit` finalize copies; 4 teardown lists) — bug #580
- #544 adopt `finalizePlanModeExit` in plan-mode-reconciler (harness ladder maps pi→claude)
- #545 `isPidAlive()` + one orphan-recovery rule (4 `process.kill(pid,0)` probes with EPERM drift; startup vs runtime orphan resolution) — bug #574
- #546 `resolveMergePolicy(prefMap, projectId)` + `mergeGateConfig()` (auto_merge × strategy × disabled × in_review × has-gate in 4 files, 3 owner predicates)
- #547 adopt `closeWorkspace()` for 5 raw `"closed"` writers (no `closedAt`)
- #548 `parseIssueNumberFromBranch()` in shared/lib/branch.ts (5 `ak-<N>` regexes; teardown over-matches)
- #549 `releaseWorkspaceResources(ws)` (8 stack-teardown copies, 5 guard variants; container reap only on 3 paths) — bug #576
- #550 `extractModelJson(text,{shape})` (6 JSON-from-LLM algorithms, 13 sites; `extractJsonObject`/`extractJsonArray`/`parseLlmJson`/`parsePluginLoopPlan` scan)
- #551 `resolveEffectiveVerify()` (gate reads `verify_script_<id>` pref, ticket-context renders profile-derived plan; 7 raw pref reads) — bug #575
- #552 `listEnabledPlugins(projectId)` (enabled-plugin loop ×10; N-query in workspace-create; `getPluginRowBySlug` unused)
- #553 route SKILL.md writers/scanners through `agent-skill-files` + `skillsDirOf()` (`materializedSkillFiles` isDirectory scan; worker-repo raw write w/o frontmatter; 14 `.claude/skills` joins)
- #554 `PluginRunContext` + table-driven `substitutePluginPlaceholders` (vars assembled ×6, loop-run args + prelude ×2)
- #555 `resolveDevcontainerProvisionOptions()` (setup vs launch build `ProvisionOptions` differently) — bug #577
- #556 `bearer-token.ts` (extractBearer ×3, mint ×4, sha256Hex ×2, expiring digest stores ×2, env-port ×2)
- #557 close injected-DB leaks behind `createWorkflowEngine` (delete `startup/review-helpers.ts` shim; `getAutoLandLoopTicket(issueId, db)`)
- #558 extend `gitService?: GitService` dep to startup engines (35 tests module-mock git.service)
- #559 `createTtlMemo()` (8 module-level TTL caches with `__reset…ForTests`; agent-questions cache pins Database)
- #560 narrow ports `BoardEventSink`/`SessionLauncher` (`ReturnType<typeof create…>` deps; 34 `as never` casts)
- #561 butler event feed as injectable sink / boardEvents subscriber (global-db import, tree-shaking hack, 13 mocks)
- #562 `migration-source.ts` (MIGRATIONS_DIR / readMigrationJournal / splitMigrationStatements; 3 prod + 6 test copies; dead `db/migrations.ts`)
- #563 `initializeProjectStatuses()` returns ids / `bootstrapProject()`; delete dead `cli/shared.ts DEFAULT_STATUSES` (137 tests hand-seed statuses)
- #564 startup audit tail as a table (`runNonFatal` / `STARTUP_AUDIT_TASKS`) — sibling of #529
- #565 `slugify()` in shared (~10 hand-rolled copies with drift) (cross-lane)
- #566 board WS event contract in shared (`BoardEventReason`, `BoardWsMessage`; 28 MCP reasons outside the union; `reason.startsWith` sniffing; 5 `RELEVANT_REASONS` sets; dead `workspace_updated`) — do with #514
- #567 monitor-status wire contract in shared (`MonitorStatusResponse`, `MonitorActionName` 7 vs 9, `MonitorWarning` discriminant, `StartPolicy` ×3, `MonitorTunables` ×3) — bug #578
- #568 board-health-event DTO + vocab consts (VALID_* sets + casts; 3 client copies)
- #569 wire-DTO single-declaration guard test + batch-1 move (90 client∩server∖shared type names; agent-questions ×6, `OrchestratorStatus`, `ScorecardResult`, `IssueComment`+`IssueCommentKind`, `PreflightResult`)
- #570 issue-domain vocab consts (`ISSUE_TYPES` 3/4/5 members across layers, `ISSUE_ESTIMATES`, `ISSUE_ARTIFACT_TYPES`, `ISSUE_COMMENT_KINDS`) — do before #516
- #571 CLI/MCP re-typed REST responses (10 all-optional interfaces in cli/workspace.ts; `AskResponse` ×2; stats blob ×4) — bug #579
- #572 `getNumber()` honours registry default (`auto_monitor_interval || "4"` ×7)
- Bugs #573 monitor gate un-pinned evidence · #574 `ready_for_merge` parked forever · #575 ticket-context vs gate verify command · #576 container reap missing on 5 terminal paths · #577 devcontainer setup ignores strict/symlink-enabled · #578 monitor popover crash on auto_contract · #579 CLI scorecard prints no score · #580 ExitPlanMode auto-resume dead code

## Sibling evidence (extra file:line for FILED tickets, found later — append here, don't refile)

- #495 ← `isBuilderSession` ×3 also at `monitor-cycle-rules.ts:47`, `rate-limit-exit-decision.ts:32`, `session-launch-helpers` (G)
- #496 ← `plugin_enabled_<slug>_<id>` slice-parse ×2 (`plugin.service.ts:171`, `plugin-loop-monitor.ts:92`); `auto_merge_disabled_<id>` set-builders ×4 (`exit-workflow:507`, `monitor-setup:537`, `orchestrator:98`) (G,H)
- #502 ← `sessions.status === "running"` limit-1 probes ×7 in reconcilers vs `repositories/session/lifecycle.ts::findRunningSession`; `updateWorkspaceStatus` ≡ `updateWorkspaceStatusOnly` (`session-lifecycle.repository.ts:171/210`) (G)
- #507 ← `getRecentAgentExcerpts` file-vs-DB duplicate JSON loop (`monitor-helpers.ts:60-104`) (G)
- #522 ← `SessionStatsBlob`/`ParsedSessionStats` ×4 in CLI/MCP (`cli/commands/session.ts:35`, `lib/issue-cli-format.ts:14-22`, `mcp-server/tools/analyze-session.ts`, `get-issue-summary.ts`); `totalCostUsd` JSON.parse in `plugin-loop.service.ts:348`, `plugin-loop-extras.service.ts:91` (J,H)
- #523 ← `DependencyType` copies `client/lib/graphLayout.ts:4`, `server/repositories/dependency-auto-chain.repository.ts:7` (missing `coupled_with`) (J)
- #524 ← `WorkerLaunchSpec` vs provider `LaunchConfig` field projection (`agent-remote.service.ts:252-263`); `buildReviewPrompt` 11-positional relay with `undefined, undefined` holes (`review.service:495-497`) (H,G)
- #526/#524 ← `isMockProfile(p) ? MOCK_AGENT_COMMAND : prefMap.get("agent_command")` ×5 (I)
- #530 ← exit-workflow direct-workspace base ref (`baseCommitSha || "HEAD~1"` at :179 vs `|| defaultBranch` at :951) (G)
- #531 ← `ServiceStackState` literal constructors ×5 + `errorState` (`workspace-services.service.ts:466,497,510,531`, `workspace-create-stack.service.ts:103-122`); `TicketContext.serviceStack` re-types it (H)
- #532 ← container detection ×2 (`board-feedback-routing.ts:65`, `service-stack-preflight.ts:112`) (H)
- #534 ← `worker-protocol.ts` private `asRecord`/`parseJson` (H)
- #499 ← `plugin-views.service.ts:203 allocateFreePort` = private copy of `port-allocator.ts:75 reservePort` (delete-and-import) (H)

## Rejected (don't refile — reason in parentheses)

- auth-rotation ring wrappers (`claude-subscription-ring`/`codex-license-ring` are thin by design)
- status-name literals `"Done"`/`"In Progress"` (`status-view.ts` / decision 005 already cover it; remaining hits are display code)
- MCP tools re-implementing server services (list-issues, start-workspace, mark-ready…) — rewrite-scale process boundary; only single chains with a shared-lib precedent qualify (#506)
- `vi.mock("../db/index")` count (services already take an injected `database`)
- `CreateWorkspaceInput` boolean flag bag (flags orthogonal; no exclusive combos)
- port literals 3001/5173 (`worktree-ports.ts` already SSOT; rest is help text)
- `harness-settings.ts` legacy ladder, `manual-migrate.ts` idempotency shim, `service-ports.ts` legacy `ak-ws-` regex, `port-allocator` legacy mode, `LEGACY_IDEMPOTENCY_CUTOFF_IDX` (constraint-driven, named, documented)
- `formatDuration` ×3, token-count formatters ×8, relative-time formatters ×6 (client; different formats per context, cosmetic)
- `parseSessionStats` ×3 client (legit projections over `parseSessionStatsBlob`) — server side IS filed as #522
- pref families as tables (`butler_*`, `board_*`, `verify_*`) — a migration is not a minimal abstraction
- `as any`/`as unknown as`/`@ts-` (8/22/0 hits, all local)
- modal/backdrop shell across 48 files (UI-component consolidation, not minimal; mechanical part is #515)
- `encodeURIComponent` on UUID ids; window CustomEvent navigation bus (already funnelled via `navigateView.ts`); query-key factories (already `boardQueryKeys.ts`)
- `merged` derived from `closed && mergedAt` ×5 (deliberated in `TERMINAL_WORKSPACE_STATUSES` doc; adjacent to #498)
- `execGit` thin wrappers ×3 (bisect/git-info/preflight; over the sanctioned adapter)
- `resolveWorktreeDevPorts` ×2–3 (already delegate to `worktree-ports.ts`)
- in-process job registry ×2 (`create-job`/`merge-job`; ~100 lines, two instances)
- `parseServicesConfig` route vs runtime (different semantics — but the codec IS #531)
- small utils (`readFileSafe`, `sanitizeCommand`, `truncateText`, `tailOutput`, `nextJobId`, `percentile`, `sha256Hex`) — trivial
- `classifySessionExit` ×2 (different layers/inputs; naming collision)
- `review-helpers.ts` prompt builders (wrappers); board-status assembly (already `board-status-entry.ts`)
- `db/migrations.ts` dead `getMigrationsFolder` + two `runMigrations` names — a 10-minute delete/rename, not a ticket
- boolean-pref `=== "true"` sites (69) — `getBool`/`parseBoolSetting` exist; adoption, not abstraction (reconciler-enabled keys folded into #529)
- `@deprecated` `devcontainer-exec.ts` alias (one-liner)
- MCP `resolveStatusByName`/`resolveActiveProjectId`/`resolveProjectName` (MCP-shaped envelopes; #508 folds the two `resolveActiveProjectId` copies)
- `bucketScorecardScores` ×2 (different in/out types); `stringValue/numberValue/objectValue` in agent-provider/helpers (folded into #534)
- `stale-dev-processes.ts` process-name sniffing (inherent to process-table matching)
- `plugin-manifest.ts` `optionalString(value, field)`/`asRecord(value, field)` (validators that throw with a field name — keep)
- `provider-config-resolution.ts` vs `project-runtime-config.service.ts` legacy markers (layered resolver by design; carriage drift is #528)
- 116 hand-rolled `is required` guards as ONE sweep (rewrite-sized; seam is #512)
- Round 3 (reason-scope named): signature-keyed retry budgets ×4 (`reviewPreflight*` #283, `merge-backoff` #417, orchestrator `reconcilerAttempts`, `workspaceAutoResumeCount`) — policies and columns genuinely differ, shared core ~30 lines; `handleUsageLimitExit` 8 positional params — one layer, no relay; `raceCandidateTimeout` as generic await-with-timeout — fine as is; ticket-context written twice with 5-positional relay (`workspace-provision.service.ts:464-500`, `workspace-create.service.ts:431-455,599-606`) — real but ~30 lines, below bar; worker `labels`/`providers` JSON columns decoded 3 ways — ~20 lines; `plugin-loop-extras.service.ts:83` inline `plugin-loop:` prefix vs `pluginLoopUnitKey` — one-liner; `cwd === "repo"|"plugin"` decode ×4 — deliberate per-kind defaults (docs); `resolveOutputRepoPath` ×9 — thin, folds into #554; 34 private test `git()` spawn helpers + 85 `git init` fixture repos — test-only builder, `gitExec` seam exists; `createFakeAgentService`/`createMockProc` copies — fixture, port is #524; `repo-path-literal-ratchet` prose — premise already fixed (#230); known-flaky lists — CPU contention, not races; `console.warn` spied in 57 tests — no single family; `pref-polarity-ratchet` baseline — boolean adoption; `status-write-ratchet` remaining entries — #501 or opaque `.set(var)`; `branch-name-single-producer` — MCP/CLI boundary; `agent-stream-parser` `setUnknownFieldLogger/Clock` — deliberate observability seam; e2e helper duplication (`createIssue` ×12, 140 raw POSTs) — needs a typed API client, rewrite-scale; `WorkspaceStatus` client re-declaration in `WorkflowProgress.tsx:45` — derived, not literal; `Session.status` vocabulary typed string with 2 label maps — display only; `PreflightResult` name collision (`preflight-check.ts` vs `ticket-preflight.service.ts`) — rename, surfaced by #569's guard; client `Project` interface ×4 — client-internal; `MilestoneSummary`/`MarketplaceEntry` — already routed via shared; `WorkspaceDetails` vs `WorkspaceResponse` vs `MainWorkspaceInfo` — one-workspace-DTO merge is bigger than one file, evidence in #569.
