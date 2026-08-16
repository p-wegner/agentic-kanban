# refactoring-scout ledger

Loop state for the `refactoring-scout` skill (`.claude/skills/refactoring-scout/SKILL.md`). A round
that is not logged here gets planned again. Read the **Lanes** table + the freshness gate in the
skill before planning a run; read **Filed** and **Rejected** as the exclusion list for scouts.

Two clocks per lane: **Last full sha** (full-lane scan; the reopen gate compares against it) and **Last diff sha** (drift-scoped scan of changed files only). Ticket-freshness passes are logged per round.

Harvest signals are numbered as in the skill (1 markers, 2 type/string sniffing, 3 guard chains,
4 copy-drifted helpers, 5 enum-by-if, 6 flag soup, 7 re-derivation, 8 ad-hoc persistence, 9 test
smells, 10 layer copies, 11 SSOT-declared-but-bypassed, 12 low-adoption helper, 13 positional
relays, 14 lifecycle boilerplate, 15 sentinel values).

## Lanes

| Lane | Paths | Last full sha | Last diff sha | Model | Signals run | Last yield (filed / rejected) | Status |
|---|---|---|---|---|---|---|---|
| whole-repo | `packages/*/src` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 | 12 / ~20 (two identical scouts, ~40% overlap) | saturated for this model unless drift |
| server-services | `packages/server/src/services/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 (+11–13 de facto) | 8 / 11 | one focused pass; healthy yield |
| client | `packages/client/src/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 (+12,14 de facto) | 8 / 9 | one focused pass; healthy yield |
| mcp-cli-routes | `packages/mcp-server/src/**`, `packages/server/src/{cli,routes,lib}/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 | 8 / 9 | one focused pass; healthy yield |
| shared-startup-repos | `packages/shared/src/**`, `packages/server/src/{startup,db,repositories}/**` | `aad29dcaee` (2026-08-16) | — | claude-fable-5 | 1–10 (+11,15 de facto) | 7 / 15 | one focused pass; healthy yield |

## Rounds

### Round 1 — 2026-08-16 — HEAD `aad29dcaee` — claude-fable-5
Two identical whole-repo scouts (A, B), skill v1 (signals 1–10). 7 + 8 findings; 3 identical, 2
overlapping → **12 tickets #493–#504**.

### Round 2 — 2026-08-16 — HEAD `aad29dcaee` — claude-fable-5
Four focused lanes (C server-services, D client, E mcp-cli-routes, F shared-startup-repos) with the
round-1 exclusion list. 8 + 8 + 8 + 7 findings; one cross-lane duplicate (C1 ≡ F3) → **30 tickets
#505–#534**. Skill v2 afterwards added signals 11–15, the ledger/freshness gate, fleet playbook,
REST filing fallback, latent-bug flagging.

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
