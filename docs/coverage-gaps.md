# Coverage Gaps Analysis

Comparison of what the app implements vs. what is covered by tests.

This snapshot focuses on the current test inventory under:

- `packages/e2e/tests`
- `packages/server/src/__tests__`

## Legend

- **Covered**: Direct test coverage was found in the scanned test trees.
- **Partially covered**: Tests exercise the behavior indirectly or cover only happy-path UI/API behavior.
- **Gap**: No direct match was found in the scanned test trees; add a focused test before relying on the behavior.

---

## 1. API Routes

### Current Coverage Snapshot

| Method | Path | Coverage | Evidence |
|--------|------|----------|----------|
| GET | `/health` | Covered | `packages/e2e/tests/api/health.test.ts` |
| GET | `/api/projects` | Covered | `packages/e2e/tests/api/projects.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| POST | `/api/projects` | Covered | `packages/e2e/tests/api/projects.test.ts`, project registration UI flow |
| GET | `/api/projects/:id/statuses` | Covered | `packages/e2e/tests/api/projects.test.ts`, many E2E setup paths |
| POST | `/api/projects/:id/statuses` | Covered | `packages/e2e/tests/api/projects.test.ts`, `packages/e2e/tests/ui/backlog-presets.test.ts` |
| GET | `/api/projects/:id/branches` | Covered | `packages/e2e/tests/api/projects.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| GET | `/api/projects/:id/board` | Covered | `packages/e2e/tests/api/board.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| GET | `/api/issues` | Covered | `packages/e2e/tests/api/issues.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| POST | `/api/issues` | Covered | `packages/e2e/tests/api/issues.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| PATCH | `/api/issues/:id` | Covered | `packages/e2e/tests/api/issues.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| DELETE | `/api/issues/:id` | Covered | `packages/e2e/tests/api/issues.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| GET | `/api/issues/:id/workspaces` | Covered | `packages/e2e/tests/api/workspaces.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| GET | `/api/issues/:id/tags` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| POST | `/api/issues/:id/tags` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| DELETE | `/api/issues/:id/tags/:tagId` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| GET | `/api/tags` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| POST | `/api/tags` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| PATCH | `/api/tags/:id` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| DELETE | `/api/tags/:id` | Covered | `packages/e2e/tests/api/tags.test.ts`, `packages/server/src/__tests__/tags.test.ts` |
| GET | `/api/preferences/active-project` | Covered | `packages/e2e/tests/api/preferences.test.ts`, `packages/server/src/__tests__/preferences.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| PUT | `/api/preferences/active-project` | Covered | `packages/e2e/tests/api/preferences.test.ts`, `packages/server/src/__tests__/preferences.test.ts`, `packages/server/src/__tests__/api.test.ts` |
| GET | `/api/preferences/settings` | Covered | `packages/e2e/tests/api/settings.test.ts`, `packages/e2e/tests/ui/settings.test.ts` |
| PUT | `/api/preferences/settings` | Covered | `packages/e2e/tests/api/settings.test.ts`, `packages/e2e/tests/ui/settings.test.ts` |
| GET | `/api/sessions/:sessionId/output` | Covered | `packages/e2e/tests/ui/session-history.test.ts`, server session output tests |
| POST | `/api/internal/board-notify` | Gap | No direct match found for `board-notify` in the scanned test trees |
| GET | `/ws/sessions/:sessionId` | Partially covered | Session lifecycle/history tests exercise session output paths; direct reconnect/error behavior remains a gap |
| GET | `/ws/board/:projectId` | Covered | `packages/e2e/tests/api/board-events.test.ts`, `packages/server/src/__tests__/board-events.test.ts` |

### Newly-covered API surface (added since 2026-05-31)

| Method | Path / behavior | Coverage | Evidence |
|--------|-----------------|----------|----------|
| GET | `/api/sessions/:id/output` (bare-array replay contract) | Covered | `packages/e2e/tests/api/session-replay.test.ts` |
| POST/GET | `/api/codemods*` (preview/apply with escape prevention, save/list CRUD) | Covered | `packages/e2e/tests/api/codemod.test.ts` |
| GET/DELETE | `/api/projects/:id/worktrees` (list, orphan detection, cascade-delete) | Covered | `packages/e2e/tests/api/worktrees.test.ts` |
| POST/GET | `/api/issues/:id/showdown`, `/api/showdowns/:id*` (N-contestant, pick-winner) | Covered | `packages/e2e/tests/api/showdown.test.ts` |
| POST | `/api/workspaces` (`tddMode` flag) + per-project TDD pref | Covered | `packages/e2e/tests/api/tdd-mode.test.ts` |
| POST | `/api/workspaces/:id/merge` (advances master, idempotent, disconnect-resilient) | Covered | `packages/e2e/tests/api/merge-advances-master.test.ts`, `packages/e2e/tests/api/merge-cascade.test.ts` |
| POST/GET | `/api/workspaces/:id/ready-for-merge` (+ board summary reflection, stale-flag regression) | Covered | `packages/e2e/tests/api/ready-for-merge.test.ts`, `packages/e2e/tests/api/stale-ready-flag-merge.test.ts` |
| GET/POST | `/api/workspaces/:id/already-merged-status`, `/reconcile-as-done` | Covered | `packages/e2e/tests/api/monitor-merge-reconciliation.test.ts` |
| CRUD | `/api/agent-skills` (built-in protection, scope, path-traversal/duplicate rejection) | Covered | `packages/e2e/tests/api/agent-skills.test.ts` |
| — | Get-by-id response shape / field-presence contract | Covered | `packages/e2e/tests/api/get-by-id-contract.test.ts` |
| POST | `/api/internal/board-notify` (broadcasts `board_changed` with projectId; no-op + empty-body cases) | Covered | `packages/e2e/tests/api/board-notify.test.ts` |
| WS | `/ws/sessions/:sessionId` reconnect/replay (valid session receives frames; unknown id opens + stays quiet — documented lenient behavior) | Covered | `packages/e2e/tests/api/ws-session-reconnect.test.ts` |
| — | Shared `{ error: string }` response-shape contract across representative routes (issue/workspace/session 404s, missing-field 400s) | Covered | `packages/e2e/tests/api/error-contract.test.ts` |

### Remaining API Gaps

1. `/ws/board/:projectId` reconnect/close handling after a dropped connection is still only indirectly exercised (the happy-path event stream is covered by `board-events.test.ts`); a dedicated reconnect test would harden it. (The session-WS reconnect path is now covered by `ws-session-reconnect.test.ts`.)
2. There is intentionally no `GET /api/projects/:id` route, so a bogus project id returns Hono's plain-text 404 rather than the JSON `{ error }` contract — the contract test uses a session 404 instead. Worth normalizing if a single-project GET is ever added.

---

## 2. Client Components and UI Flows

| Component / Flow | Coverage | Evidence |
|------------------|----------|----------|
| Board columns and issue cards | Covered | `packages/e2e/tests/ui/board.test.ts`, `board-stats-bar.test.ts`, `priority-sort.test.ts` |
| Archive column group | Covered | `packages/e2e/tests/ui/archive-columns.test.ts` |
| Command palette | Covered | `packages/e2e/tests/ui/command-palette.test.ts`, `command-palette-workspace.test.ts` |
| Create issue form | Covered | `packages/e2e/tests/ui/board.test.ts`, `expandable-create-panel.test.ts` |
| Diff viewer | Covered | `packages/e2e/tests/ui/diff-viewer.test.ts`, `workspace.test.ts` |
| Issue detail panel | Covered | `packages/e2e/tests/ui/board.test.ts`, issue description tests |
| Settings panel | Covered | `packages/e2e/tests/ui/settings.test.ts`, settings-specific API/UI tests |
| Shortcut help overlay | Covered | `packages/e2e/tests/ui/shortcuts.test.ts` |
| Search highlighting | Covered | `packages/e2e/tests/ui/search.test.ts` |
| Terminal/session views | Covered | `packages/e2e/tests/ui/workspace.test.ts`, `session-history.test.ts`, `workspace-chat.test.ts` |
| Workspace panel diff and merge actions | Covered | `packages/e2e/tests/ui/workspace.test.ts`, `diff-viewer.test.ts` |
| Project registration/switching support | Covered | `packages/e2e/tests/ui/register-project.test.ts`, `active-project-recovery.test.ts`, active-project preference tests |
| Board stats bar / priority-sort / bulk-select / context menu | Covered | `packages/e2e/tests/ui/board-stats-bar.test.ts`, `priority-sort.test.ts`, `board-card-bulk-select.test.ts`, `issue-card-context-menu.test.ts` |
| Issue dependencies UI | Covered | `packages/e2e/tests/ui/issue-dependencies.test.ts` |
| Quick Tasks panel | Covered | `packages/e2e/tests/ui/quick-tasks-panel.test.ts` |
| All Workspaces panel / Merge Queue panel / Worktrees panel | Covered | `packages/e2e/tests/ui/all-workspaces-panel.test.ts`, `merge-queue-panel.test.ts`, `worktrees-panel.test.ts` |
| Settings Workflow tab / Scheduled Runs / Agent profile dashboard | Covered | `packages/e2e/tests/ui/settings-workflow.test.ts`, `settings-scheduled-runs.test.ts`, `agent-profile-dashboard.test.ts` |
| AI Reviewed column / Ready-for-Merge badge / session stats / task progress | Covered | `packages/e2e/tests/ui/ai-reviewed-column.test.ts`, `ready-for-merge-badge.test.ts`, `session-stats.test.ts`, `task-progress.test.ts` |
| Issue detail extras — skip-review toggle / blocked-by banner / expand modal / follow-up create / markdown preview | Covered | `packages/e2e/tests/ui/skip-review-toggle.test.ts`, `blocked-by-banner.test.ts`, `issue-detail-expand.test.ts`, `follow-up-task.test.ts`, `markdown-preview-toggle.test.ts` |
| Direct workspace UI / VS Code button / Worktrees row actions / Graph-fit + Table columns | Covered | `packages/e2e/tests/ui/direct-workspace-ui.test.ts`, `workspace-vscode-button.test.ts`, `worktrees-row-actions.test.ts`, `graph-table-extras.test.ts` |
| Toast notifications | Covered | Success toasts in `settings.test.ts`, `command-palette.test.ts`, `settings-scheduled-runs.test.ts`; a dedicated **failure** toast (route-forced 500 → error toast + auto-dismiss) in `failure-toast.test.ts` |
| Skeleton/loading state | Covered | `packages/e2e/tests/ui/skeleton-board.test.ts` route-delays the board response and asserts `SkeletonBoard` shows then is replaced |

### Remaining UI Gaps

1. `SkeletonBoard.tsx` loading state: add a UI test that delays the board response and asserts the skeleton appears before board content.
2. Toast coverage is selective. Add tests for representative failure toasts, especially tag CRUD and dependency-cycle errors, instead of only save/review/delete success paths.
3. Project switching through the header dropdown is indirectly supported by active-project API tests and project registration tests, but a direct header switcher workflow test would make regressions easier to catch.

---

## 3. MCP Tools

The requested scan did not cover `packages/mcp-server/src/__tests__`, but MCP tool coverage lives there.

| Tool / Behavior | Coverage | Evidence |
|-----------------|----------|----------|
| Board/issue context tools | Covered outside this scan | MCP test files live under `packages/mcp-server/src/__tests__` |
| `get_workspace_diff` / `get-workspace-diff` | Covered | `packages/mcp-server/src/__tests__/tools/get-workspace-diff.test.ts` seeds a git workspace branch and asserts changed files, diff text, and non-zero stats |

Remaining MCP gap: add error-path coverage for a missing workspace if this tool grows more fallback behavior.

---

## 4. CLI Commands

The previous document claimed all root CLI commands were untested. That is stale.

| Command | Coverage | Evidence |
|---------|----------|----------|
| `register` | Covered | `packages/server/src/__tests__/cli.test.ts` |
| `unregister` | Covered | `packages/server/src/__tests__/cli.test.ts` |
| `list` | Covered | `packages/server/src/__tests__/cli.test.ts` |
| `cleanup` | Covered | `packages/server/src/__tests__/cli.test.ts` |
| `issue list` / issue workflows | Covered | `packages/server/src/__tests__/cli.test.ts` |
| `workspace list` | Covered | `packages/server/src/__tests__/cli.test.ts` |
| `skill list` | Covered | `packages/server/src/__tests__/cli.test.ts` |
| Butler CLI commands | Covered | `packages/server/src/__tests__/cli-butler.test.ts` |

Remaining CLI gap: the tests are spawn-based and broad. For new CLI commands, add command-specific cases to `cli.test.ts` or `cli-butler.test.ts` and include at least one failure path, not only `--help`.

---

## 5. Unit Test Subjects

Several older unit-test gaps are now stale:

- `agent.service.ts` has focused tests in `packages/server/src/__tests__/agent.service.test.ts` and `process-guard.test.ts`.
- `session.manager.ts` has coverage in `packages/server/src/__tests__/session.manager.test.ts`.
- `board-events.ts` has coverage in `packages/server/src/__tests__/board-events.test.ts`.
- Tag CRUD routes and services are covered in `packages/server/src/__tests__/tags.test.ts`.
- Issue number auto-increment is covered in `packages/server/src/__tests__/issue-number.test.ts`.
- Preferences validation and active-project behavior are covered in `packages/server/src/__tests__/preferences.test.ts`.

Remaining unit gaps to keep actionable:

1. Shared error response formatting: add route-level tests that assert consistent `{ error: string }` responses across representative project, issue, tag, and workspace endpoints.
2. WebSocket lifecycle edge cases: add server-level tests for stale session IDs, reconnects, and cleanup after close.
3. Loading-state UI logic is still only E2E-observable; if `SkeletonBoard` gains conditional logic, add a component-level or route-delay E2E test.

---

## 6. Documentation vs Implementation

### Historical PRD docs

The `docs/prd/` folder still describes the original vibe-kanban analysis and early implementation plan. Treat it as historical context unless a page explicitly says it has been refreshed.

Known stale areas:

1. `docs/prd/01-features-catalog.md` includes features that were deliberately skipped or later replaced.
2. `docs/prd/03-data-model.md` does not fully describe the current Drizzle schema.
3. `docs/prd/05-mvp-scope.md` reflects the original staged MVP plan, not the current stage 13+ implementation.

### Missing or thin user-facing docs

1. API reference with request/response schemas.
2. WebSocket protocol docs for `/ws/sessions/:sessionId` and `/ws/board/:projectId`.
3. MCP tool schema/reference docs for inputs, outputs, and common errors.
4. Deployment/production runbook beyond development mode.
5. Error response format conventions.
6. Windows compatibility notes for users, separate from agent-only `CLAUDE.md` instructions.

---

## 7. Summary

| Category | Current state | Remaining actionable gaps |
|----------|---------------|---------------------------|
| API routes | Previously stale gaps for health, tags, statuses, branches, and active-project are covered | `POST /api/internal/board-notify`, WebSocket edge cases, shared error format |
| UI flows | Previously stale gaps for archive columns, shortcut help, search highlighting, diff viewer, and merge UI are covered | Skeleton loading state, broader failure-toast coverage, direct header project-switch workflow |
| MCP tools | Most MCP coverage lives outside the requested scan | Add command-specific MCP error-path cases as tools change |
| CLI commands | Root CLI commands are covered in `cli.test.ts` | Keep adding command-specific failure-path cases for new commands |
| Unit tests | Agent service, session manager, board events, tags, issue numbers, and preferences are no longer untested | Add focused edge-case and contract tests where listed above |

## Last Verified

Re-audited on 2026-06-17 via a parallel sweep of every spec under `packages/e2e/tests/` (~80 files). Since 2026-05-31, ~21 previously-"Not yet covered" tickets gained E2E coverage and ~13 new API/UI spec files were added (merge lifecycle, worktrees, codemod, showdown, TDD mode, agent-skills API, get-by-id contract, board-monitor toolbar, project scripts, active-project recovery). Detailed feature→file mapping lives in `docs/prd/06-testability-strategy.md`.

Then on 2026-06-17, **16 new spec files were authored and verified green** to close the remaining gaps: `issue-artifacts`, `board-notify`, `error-contract`, `ws-session-reconnect` (API) and `skip-review-toggle`, `blocked-by-banner`, `issue-detail-expand`, `follow-up-task`, `markdown-preview-toggle`, `workspace-vscode-button`, `worktrees-row-actions`, `direct-workspace-ui`, `graph-table-extras`, `auto-start-followup-setting`, `failure-toast`, `skeleton-board` (UI). Remaining open gaps are now narrow: `/ws/board/:projectId` reconnect-after-drop, F-WS-08 workspace setup scripts (#183), and the Windows-EBUSY-blocked "row Delete actually removes the worktree" assertion (#206 — button + confirm are covered; bulk removal is covered in `worktrees-panel.test.ts`).

Originally verified on 2026-05-31 with these repository searches:

```powershell
rg --files packages/e2e/tests packages/server/src/__tests__
rg -n "GET /health|POST /api/projects|/api/preferences/active-project|/api/projects/.*/branches|/api/projects/.*statuses|/api/issues/.*/tags|/api/tags|/api/internal/board-notify" packages/e2e/tests packages/server/src/__tests__
rg -n "shortcut|Keyboard shortcuts|archive|Completed|DiffViewer|View Diff|Merge button|skeleton|toast|Toast|project switch|active project|base branch" packages/e2e/tests packages/server/src/__tests__
rg -n "register|unregister|list|cleanup" packages/server/src/__tests__/cli.test.ts packages/server/src/__tests__/cli-butler.test.ts packages/e2e/tests packages/server/src/__tests__
rg -n "get_workspace_diff|get-workspace-diff|getWorkspaceDiff|workspace diff" packages/e2e/tests packages/server/src/__tests__ packages/mcp-server/src/__tests__
```
