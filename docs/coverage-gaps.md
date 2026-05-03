# Coverage Gaps Analysis

Comparison of what the app implements vs. what's documented vs. what's tested.

## Legend
- **UNTESTED**: Feature exists in code, has no unit or E2E test
- **UNDOCUMENTED**: Feature exists in code, not mentioned in docs/CLAUDE.md
- **STALE DOC**: Documentation describes behavior that differs from implementation

---

## 1. API Routes

### Route Coverage Matrix

| Method | Path | Unit Test | E2E Test | Notes |
|--------|------|-----------|----------|-------|
| GET | /health | - | - | No test at all |
| GET | /api/projects | - | partial | Used in global setup, not directly tested |
| POST | /api/projects | - | - | **UNTESTED** — only tested indirectly via global setup |
| GET | /api/projects/:id/statuses | - | - | **UNTESTED** |
| POST | /api/projects/:id/statuses | - | - | **UNTESTED** |
| GET | /api/projects/:id/branches | - | - | **UNTESTED** |
| GET | /api/projects/:id/board | - | yes | `board.test.ts` (3 tests) |
| GET | /api/issues | - | yes | `issues.test.ts` (2 tests) |
| POST | /api/issues | - | yes | `issues.test.ts` (1 test) |
| PATCH | /api/issues/:id | - | yes | `issues.test.ts` (1 test) |
| DELETE | /api/issues/:id | - | yes | `issues.test.ts` (1 test) |
| GET | /api/issues/:id/workspaces | - | yes | `workspaces.test.ts` |
| GET | /api/issues/:id/tags | - | - | **UNTESTED** |
| POST | /api/issues/:id/tags | - | - | **UNTESTED** |
| DELETE | /api/issues/:id/tags/:tagId | - | - | **UNTESTED** |
| POST | /api/workspaces | - | yes | `workspaces.test.ts`, `workspace-lifecycle.test.ts` |
| GET | /api/workspaces/:id | - | yes | `workspaces.test.ts` |
| PATCH | /api/workspaces/:id | - | yes | `workspaces.test.ts` |
| DELETE | /api/workspaces/:id | - | yes | `workspaces.test.ts` |
| POST | /api/workspaces/:id/setup | - | yes | `workspaces.test.ts` |
| POST | /api/workspaces/:id/launch | - | yes | `workspace-lifecycle.test.ts` |
| POST | /api/workspaces/:id/stop | - | yes | `workspace-lifecycle.test.ts` |
| GET | /api/workspaces/:id/diff | - | yes | `workspace-lifecycle.test.ts` |
| POST | /api/workspaces/:id/merge | - | yes | `workspace-lifecycle.test.ts` |
| GET | /api/workspaces/:id/sessions | - | yes | `workspace-lifecycle.test.ts` |
| GET | /api/tags | - | - | **UNTESTED** (standalone route) |
| POST | /api/tags | - | - | **UNTESTED** |
| PATCH | /api/tags/:id | - | - | **UNTESTED** |
| DELETE | /api/tags/:id | - | - | **UNTESTED** |
| GET | /api/preferences/active-project | - | - | **UNTESTED** |
| PUT | /api/preferences/active-project | - | - | **UNTESTED** |
| GET | /api/preferences/settings | - | yes | `settings.test.ts` |
| PUT | /api/preferences/settings | - | yes | `settings.test.ts` |
| GET | /api/sessions/:sessionId/output | - | yes | `session-history.test.ts` |
| POST | /api/internal/board-notify | - | - | **UNTESTED** (internal route) |
| GET | /ws/sessions/:sessionId | - | - | Tested indirectly via session-lifecycle E2E |
| GET | /ws/board/:projectId | - | yes | `board-events.test.ts` |

### Routes with ZERO test coverage (8 routes)
1. `GET /health` — no test at all
2. `POST /api/projects/:id/statuses` — status CRUD never tested
3. `GET /api/issues/:id/tags` — tag listing per issue
4. `POST /api/issues/:id/tags` — tag assignment
5. `DELETE /api/issues/:id/tags/:tagId` — tag removal
6. `GET /api/tags` — list all tags (no standalone test)
7. `POST /api/tags` — create tag
8. `PATCH /api/tags/:id` / `DELETE /api/tags/:id` — tag update/delete
9. `GET/PUT /api/preferences/active-project` — project switching
10. `GET /api/projects/:id/branches` — branch listing
11. `POST /api/internal/board-notify` — internal board refresh trigger

Note: Tags ARE tested via UI E2E (`board.test.ts` tag tests), but the API routes themselves have no direct test. Status CRUD is only tested indirectly (seed creates 5 statuses, but no test creates/reads them via API).

---

## 2. Client Components vs E2E Coverage

| Component | File | E2E Coverage | Notes |
|-----------|------|-------------|-------|
| BoardColumn | `BoardColumn.tsx` | partial | DnD tested in `board.test.ts`; column rendering tested |
| ColumnGroup | `ColumnGroup.tsx` | none | **UNTESTED** — collapse/expand of archive columns |
| CommandPalette | `CommandPalette.tsx` | yes | `command-palette.test.ts` (5 tests) |
| CreateIssueForm | `CreateIssueForm.tsx` | yes | `board.test.ts` (create + cancel tests) |
| DiffViewer | `DiffViewer.tsx` | none | **UNTESTED** — no E2E test views a diff in the UI |
| IssueCard | `IssueCard.tsx` | partial | Rendered in board tests; highlighting not tested |
| IssueDetailPanel | `IssueDetailPanel.tsx` | yes | `board.test.ts` (open/edit/delete/status/tags) |
| Layout | `Layout.tsx` | partial | Header rendering tested in board tests |
| SettingsPanel | `SettingsPanel.tsx` | yes | `settings.test.ts` (6 tests) |
| ShortcutHelp | `ShortcutHelp.tsx` | none | **UNTESTED** — ? key overlay never tested |
| SkeletonBoard | `SkeletonBoard.tsx` | none | **UNTESTED** — loading state not tested |
| TerminalView | `TerminalView.tsx` | partial | Tested in `workspace.test.ts` and `session-history.test.ts` |
| Toast | `Toast.tsx` | none | **UNTESTED** — toast notifications never asserted |
| WorkspacePanel | `WorkspacePanel.tsx` | yes | `workspace.test.ts`, `session-history.test.ts` |

### UI Flows with NO E2E Test
1. **Archive column group** — expanding/collapsing Done/Cancelled group (`ColumnGroup.tsx`)
2. **DiffViewer** — viewing a workspace diff in the panel (`DiffViewer.tsx`)
3. **ShortcutHelp overlay** — pressing `?` to show keyboard shortcuts (`ShortcutHelp.tsx`)
4. **Search result highlighting** — typing in search and seeing `<mark>` highlights on cards
5. **Toast notifications** — tag CRUD error toasts, success toasts
6. **Project switcher** — switching between registered projects via header dropdown
7. **Skeleton/loading state** — initial board load skeleton
8. **Merge from UI** — no E2E test clicks "Merge" button in workspace panel
9. **Workspace creation with base branch** — selecting a non-default base branch in create form

---

## 3. MCP Tools

| Tool | File | E2E Test | Notes |
|------|------|----------|-------|
| get_context | `get-context.ts` | yes | `mcp.test.ts` round-trip |
| list_issues | `list-issues.ts` | yes | `mcp.test.ts` round-trip |
| get_issue | `get-issue.ts` | yes | `mcp.test.ts` round-trip |
| create_issue | `create-issue.ts` | yes | `mcp.test.ts` round-trip |
| update_issue | `update-issue.ts` | yes | `mcp.test.ts` round-trip |
| list_workspaces | `list-workspaces.ts` | partial | Covered in round-trip but no standalone test |
| start_workspace | `start-workspace.ts` | partial | Covered in round-trip but no standalone test |
| get_workspace_diff | `get-workspace-diff.ts` | none | **UNTESTED** — no E2E test calls this tool |

MCP tests are all in a single round-trip test file (`mcp.test.ts`). No individual tool has isolated tests for error cases or edge cases.

---

## 4. CLI Commands

| Command | File:Line | Test | Notes |
|---------|-----------|------|-------|
| register | `cli.ts:30` | none | **UNTESTED** — only tested manually via E2E global setup using API |
| unregister | `cli.ts:107` | none | **UNTESTED** |
| list | `cli.ts:182` | none | **UNTESTED** |
| cleanup | `cli.ts:221` | none | **UNTESTED** |

All CLI commands have zero test coverage. The E2E tests use the API directly to register projects, bypassing the CLI entirely.

---

## 5. Unit Tests

Current unit tests (28 total) are in:
- `packages/server/src/__tests__/api.test.ts` — DB migration + API setup validation
- `packages/server/src/__tests__/git.service.test.ts` — Git worktree operations
- `packages/server/src/__tests__/git-info.service.test.ts` — Git repo info detection

### No Unit Tests For
- `agent.service.ts` — agent subprocess launch/kill
- `session.manager.ts` — session lifecycle, WS broadcast, message persistence
- `board-events.ts` — board event broadcasting
- Any route handler logic (routes are only tested via E2E)
- Tag CRUD service logic
- Issue number auto-increment logic
- Preferences whitelist validation
- Output parser logic

---

## 6. Documentation vs Implementation

### STALE DOC — docs/prd/ describes original vibe-kanban, not this implementation
The `docs/prd/` folder documents the *original* vibe-kanban project analysis, not the current implementation. While useful as historical reference, several features listed there don't match:
- `01-features-catalog.md` lists many features we deliberately skipped (assignees, relationships, etc.)
- `03-data-model.md` describes the original schema, not our Drizzle schema
- `05-mvp-scope.md` defined a 6-stage plan; we implemented 12 stages

### Missing from docs
1. **No API reference** — state.md has a route table but no request/response schemas
2. **No WebSocket protocol docs** — message format for `/ws/sessions/:id` and `/ws/board/:id`
3. **No MCP tool schemas** — input/output formats for each tool
4. **No deployment guide** — how to run in production (just dev mode documented)
5. **Stream-json format** — referenced in CLAUDE.md but example file is in `docs/reference/`, not explained inline
6. **Session resume chain** — `--resume` flow documented in CLAUDE.md only, not in user-facing docs
7. **Error handling** — no documentation of error response formats
8. **Windows compatibility** — agent launch uses `shell:true`, path normalization, not documented for users

### Docs describe features that behave differently
1. `docs/state.md` says "28 unit tests + 60 E2E tests passing" — still accurate but test count is fixed
2. `CLAUDE.md` says "Session history: past sessions with replayable output in workspace panel" — was updated but could be more specific about inline selector

---

## 7. Summary Statistics

| Category | Total | Tested | Gap |
|----------|-------|--------|-----|
| API routes | ~28 | ~26 | **2 untested** |
| Client components | 14 | ~13 | **1 untested** |
| MCP tools | 8 | 7 | **1 untested** |
| CLI commands | 4 | 0 | **4 untested** |
| Unit test subjects | 7+ services | 6 | **1+ untested** |

### Previously identified gaps — now addressed

| Gap | Status | Tests Added |
|-----|--------|-------------|
| Tags API (5 routes) | **FIXED** | 12 E2E tests + 13 unit tests |
| Status CRUD API | **FIXED** | 2 E2E tests (projects.test.ts) |
| Active project switching | **FIXED** | 3 E2E tests (preferences.test.ts) + 10 unit tests |
| Branch listing API | **FIXED** | 2 E2E tests (projects.test.ts) |
| Health endpoint | **FIXED** | 1 E2E test (health.test.ts) |
| ColumnGroup collapse/expand | **FIXED** | 4 E2E tests (archive-columns.test.ts) |
| Search highlighting | **FIXED** | 6 E2E tests (search.test.ts) |
| DiffViewer UI | **FIXED** | 1 E2E test (workspace.test.ts) |
| Merge from UI | **FIXED** | 1 E2E test (workspace.test.ts) |
| ShortcutHelp overlay | **FIXED** | 5 E2E tests (shortcuts.test.ts) |
| Issue number auto-increment | **FIXED** | 11 unit tests (issue-number.test.ts) |
| Preferences whitelist | **FIXED** | 10 unit tests (preferences.test.ts) |

### Remaining gaps

**Untested:**
1. `POST /api/internal/board-notify` — internal route, low priority
2. CLI commands (register, unregister, list, cleanup) — no test infrastructure for CLI
3. `get_workspace_diff` MCP tool — no standalone test
4. Toast notifications — no E2E test
5. Skeleton/loading state — no E2E test

**Low priority:**
6. WebSocket reconnection scenarios
7. Error response format testing
8. Agent service unit tests
9. Session manager unit tests
10. Board events service unit tests
