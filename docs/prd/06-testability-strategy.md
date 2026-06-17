# PRD-06: Testability Strategy

## Philosophy
> If an AI can't test it, we can't ship it.

Every feature must be verifiable through automated tests that an AI agent can run, interpret, and use as feedback for iteration.

## Test Pyramid

```
         ┌──────────┐
         │   E2E    │  ← Playwright (user workflows + API calls)
         │  Tests   │
        ┌┴──────────┴┐
        │ Integration │  ← MCP stdio + Git worktree lifecycle
        │   Tests     │
       ┌┴────────────┴┐
       │   Unit Tests   │  ← Vitest (pure logic, in-memory DB)
       └──────────────┘
```

## Test Infrastructure

### Unit Tests (Vitest)
- Run via `pnpm --filter @agentic-kanban/server test`
- In-memory SQLite database for isolation
- Factory-style test data setup
- 263 tests covering: tags CRUD, preferences, issue numbers, API routes, git service

### E2E Tests (Playwright)
- Run via `pnpm test:e2e`
- Full server + client startup via global setup
- Tests create their own data, no shared state dependencies
- ~212 tests covering: API endpoints, UI interactions, MCP tools, board events, sessions

### MCP Protocol Tests
- Custom stdio JSON-RPC client against MCP server
- Round-trip tests: create → list → update → get_issue
- Validates MCP tools work correctly with the shared DB

## Test Examples

### Unit Test (Vitest)
```typescript
// packages/server/src/__tests__/api.test.ts
import { describe, it, expect, beforeEach } from "vitest";

describe("Tags API", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb(); // in-memory SQLite with migrations applied
  });

  it("should create a tag", async () => {
    const tag = await createTag(db, { name: "bug", color: "#EF4444" });
    expect(tag.name).toBe("bug");
    expect(tag.color).toBe("#EF4444");
  });

  it("should cascade delete tag associations", async () => {
    const tag = await createTag(db, { name: "feature" });
    const issue = await createIssue(db, { title: "Test", projectId });
    await assignTag(db, { issueId: issue.id, tagId: tag.id });
    await deleteTag(db, tag.id);
    const associations = await getIssueTags(db, issue.id);
    expect(associations).toHaveLength(0);
  });
});
```

### E2E API Test (Playwright)
```typescript
// packages/e2e/tests/api.test.ts
import { test, expect } from "@playwright/test";

test("should create and retrieve issue", async ({ request }) => {
  const response = await request.post("/api/issues", {
    data: {
      projectId,
      title: "Fix login bug",
      priority: "high",
      statusId: todoStatusId,
    },
  });
  expect(response.ok()).toBeTruthy();
  const issue = await response.json();
  expect(issue.title).toBe("Fix login bug");

  // Verify retrieval
  const getResponse = await request.get(`/api/issues/${issue.id}`);
  const fetched = await getResponse.json();
  expect(fetched.priority).toBe("high");
});
```

### E2E UI Test (Playwright)
```typescript
// packages/e2e/tests/board.test.ts
import { test, expect } from "@playwright/test";

test("should create issue inline and show on board", async ({ page }) => {
  await page.goto(`/projects/${projectId}`);

  // Click "Add Issue" in Todo column
  const todoColumn = page.locator("[data-testid='column-Todo']");
  await todoColumn.locator("button", { hasText: "+" }).click();

  // Fill and submit inline form
  await todoColumn.locator("input[placeholder*='title']").fill("My new task");
  await todoColumn.locator("button", { hasText: "Add" }).click();

  // Verify card appears
  await expect(page.locator("text=My new task")).toBeVisible();
});
```

### MCP Tool Test (Playwright)
```typescript
// packages/e2e/tests/mcp.test.ts
import { test, expect } from "@playwright/test";

test("MCP round-trip: create → list → update", async () => {
  const client = createMcpClient(); // stdio JSON-RPC client

  // Create issue via MCP
  const created = await client.callTool("create_issue", {
    title: "MCP test issue",
    priority: "medium",
  });
  const issueId = JSON.parse(created.content[0].text).id;

  // List and find
  const listed = await client.callTool("list_issues", { projectId });
  const issues = JSON.parse(listed.content[0].text);
  expect(issues.find((i: any) => i.id === issueId)).toBeDefined();

  // Update status
  await client.callTool("update_issue", {
    issueId,
    statusName: "In Progress",
  });

  // Verify via API
  const response = await request.get(`/api/issues/${issueId}`);
  expect((await response.json()).status.name).toBe("In Progress");
});
```

## AI-Driven Development Loop

### The Feedback Cycle
```
1. AI writes code
2. AI runs tests (pnpm --filter @agentic-kanban/server test or pnpm test:e2e)
3. AI reads test output
4. If tests fail → AI reads error + screenshot → fixes code → goto 2
5. If tests pass → AI moves to next feature
```

### Requirements for AI-Friendly Tests
1. **Deterministic**: Same input = same output (no flaky tests)
2. **Fast**: Full suite < 60s, focused test < 5s
3. **Clear errors**: Descriptive assertion messages
4. **Screenshots on failure**: Visual context for UI bugs
5. **Isolated**: Each test creates its own data, no shared state
6. **Parallel-safe**: Tests can run concurrently

### Test Data Strategy
- **Global setup**: Creates project via API before all tests
- **Per-test data**: Tests create issues/tags/workspaces as needed
- **Unique suffixes**: `Date.now()` for titles to avoid cross-run collisions
- **Cleanup**: `test.afterAll` resets preferences/settings state

## Test Tools

| Tool | Purpose |
|------|---------|
| **Vitest** | Unit tests with in-memory DB |
| **Playwright** | E2E browser + API tests |
| **In-memory SQLite** | Fast unit test isolation |
| **Custom MCP client** | Stdio JSON-RPC tool testing |

## Test Commands

```bash
pnpm --filter @agentic-kanban/server test    # Unit tests (263 tests)
pnpm test:e2e                                  # E2E tests (~212 tests)
```

## Current E2E Coverage

_Last updated: 2026-06-17 (full re-audit of `packages/e2e/tests/`, ~80 spec files)_

### ✅ Covered features

| Feature | Test file(s) |
|---------|-------------|
| F-TASK-01: Issues CRUD (create/update/delete, estimate) | `packages/server/src/__tests__/api.test.ts`, `packages/e2e/tests/api/issues.test.ts` |
| F-TASK-01: Image paste in issue description editor (Ctrl+V, preview thumbnails, markdown insert) | `packages/e2e/tests/ui/issue-description-paste.test.ts` |
| F-TASK-02: Kanban board view, inline create, detail panel, drag-drop | `packages/e2e/tests/ui/board.test.ts` |
| F-TASK-02: Collapsible archive column group (Done/Cancelled) | `packages/e2e/tests/ui/archive-columns.test.ts` |
| F-TASK-02: Drag issue from backlog onto empty agent workspace slot | `packages/e2e/tests/ui/drag-backlog-to-start.test.ts` |
| F-TASK-02: Bulk card selection (Ctrl-click) + bulk priority change | `packages/e2e/tests/ui/board-card-bulk-select.test.ts` |
| F-TASK-02: Issue-card right-click context menu (copy reference, move status) | `packages/e2e/tests/ui/issue-card-context-menu.test.ts` |
| F-TASK-02: Backlog filter presets / promote-to-Todo | `packages/e2e/tests/ui/backlog-presets.test.ts`, `packages/e2e/tests/ui/backlog-promote.test.ts` |
| F-TASK-03: Real-time search, priority filter | `packages/e2e/tests/ui/search.test.ts` |
| F-TASK-04: Tags CRUD + assignment to issues (API) | `packages/e2e/tests/api/tags.test.ts` |
| F-TASK-04: Tags management via Settings > Tags tab UI (rename, delete, add, merge, color) | `packages/e2e/tests/ui/settings-tags.test.ts` |
| F-TASK-04: Tag assignment/removal in issue detail panel | `packages/e2e/tests/ui/issue-tag-assignment.test.ts` |
| F-TASK-05: Issue dependencies UI (dependencies section, add/remove deps) | `packages/e2e/tests/ui/issue-dependencies.test.ts` |
| F-WS-01/03: Workspace creation, board workspace summary | `packages/e2e/tests/api/workspaces.test.ts`, `packages/e2e/tests/api/board-workspace-summary.test.ts` |
| F-WS-02: Agent session lifecycle, launch/stop, output persistence | `packages/e2e/tests/api/workspace-lifecycle.test.ts`, `packages/e2e/tests/api/session-history.test.ts` |
| F-WS-02: Stream-json output parsing UI | `packages/e2e/tests/output-parser.spec.ts` |
| F-WS-02: Mock agent profiles (standard/UUID/multi-turn/error/delay, resume chain, /turn 409) | `packages/e2e/tests/api/mock-agent-profiles.test.ts` |
| F-WS-02: Workspace launch preview (resolved branch/base/provider, active-workspace warning) | `packages/e2e/tests/ui/workspace-launch-preview.test.ts` |
| F-WS-04: Git branch creation for workspaces | `packages/e2e/tests/api/workspaces.test.ts` |
| F-WS-05: Workspace deletion | `packages/e2e/tests/api/workspaces.test.ts` |
| F-WS-06: Merge advances master (commit reaches master, idempotent merge, disconnect-resilience) | `packages/e2e/tests/api/merge-advances-master.test.ts`, `packages/e2e/tests/api/merge-cascade.test.ts` |
| F-WS-06: Ready-for-merge flag (set/reflect in workspace + board summary, stale-flag regression) | `packages/e2e/tests/api/ready-for-merge.test.ts`, `packages/e2e/tests/api/stale-ready-flag-merge.test.ts` |
| F-WS-06: Merge reconciliation (already-merged detection, reconcile-as-done) | `packages/e2e/tests/api/monitor-merge-reconciliation.test.ts` |
| F-WS-07: Worktrees API (list, orphan detection, cascade-delete) | `packages/e2e/tests/api/worktrees.test.ts` |
| F-REV-01: Diff viewer UI (file tree, diff lines, unified/split view, real diff content) | `packages/e2e/tests/ui/diff-viewer.test.ts` |
| F-REV-02: Diff comments API (create/edit/delete/filter) + inline comment UI (CRUD via diff viewer) | `packages/server/src/__tests__/api.test.ts`, `packages/e2e/tests/ui/diff-viewer.test.ts` |
| F-REV-03: AI code review flow (manual review button, reviewing badge, session output, auto-review/fix prefs) | `packages/e2e/tests/ui/code-review.test.ts` |
| F-REV-04: Showdown (N-contestant create, list, pick-winner workspace state) | `packages/e2e/tests/api/showdown.test.ts` |
| F-REV-05: TDD mode (built-in skill, `tddMode` workspace flag, per-project pref) | `packages/e2e/tests/api/tdd-mode.test.ts` |
| F-MCP-01: MCP server tools (get_context, list/create/update/get_issue, list_workspaces, active-project resolution) | `packages/mcp-server/src/__tests__/mcp-tools.test.ts` |
| F-MCP-03: Agent command configuration via settings | `packages/e2e/tests/api/settings.test.ts` |
| F-MCP-04: Agent Skills UI in Settings (built-in protection, custom skill CRUD, edit/delete, Enhance-with-AI, Install button) | `packages/e2e/tests/ui/agent-skills.test.ts` |
| F-MCP-04: Agent Skills API (CRUD, built-in protection, project + global scope, path-traversal/duplicate rejection) | `packages/e2e/tests/api/agent-skills.test.ts` |
| F-MCP-04: Skill selector in inline issue create form (Start Workspace checkbox) | `packages/e2e/tests/ui/agent-skills.test.ts` |
| F-UI-01: Register project / Create project UI | `packages/e2e/tests/ui/register-project.test.ts` |
| F-UI-02: Workspace panel open, diff view, merge | `packages/e2e/tests/ui/workspace.test.ts` |
| F-UI-02: Workspace panel chat input / multi-turn interaction (Send/Stop, Ctrl+Enter, turn state) | `packages/e2e/tests/ui/workspace-chat.test.ts` |
| F-UI-03: Command palette (Ctrl+K, filter, navigate, execute, project switch) | `packages/e2e/tests/ui/command-palette.test.ts` |
| F-UI-03: Command palette workspace actions (Review and Merge) | `packages/e2e/tests/ui/command-palette-workspace.test.ts` |
| F-UI-04: Keyboard shortcuts (? overlay, Escape, `/` search, view-switching b/g/t/u/q) | `packages/e2e/tests/ui/shortcuts.test.ts` |
| F-UI-06: Merge Queue panel (In Review workspaces with risk/ready/age metrics, merge controls) | `packages/e2e/tests/ui/merge-queue-panel.test.ts` |
| F-UI-07: Worktrees panel (orphan detection, orange badge, bulk-clean confirm/cancel) | `packages/e2e/tests/ui/worktrees-panel.test.ts` |
| F-UI-08: Expandable issue creation panel (full-screen form, plan mode, skip review checkboxes) | `packages/e2e/tests/ui/expandable-create-panel.test.ts` |
| F-UI-08: Profile override field in expanded issue create panel and workspace create relaunch | `packages/e2e/tests/ui/profile-override.test.ts` |
| F-UI-09: Settings panel (agent command, mock agent toggle, persist) | `packages/e2e/tests/ui/settings.test.ts`, `packages/e2e/tests/api/settings.test.ts` |
| F-UI-09: Settings Workflow tab (pipeline visualization, auto-review/fix/merge + auto-monitor toggles, interval) | `packages/e2e/tests/ui/settings-workflow.test.ts` |
| F-UI-09: Scheduled Runs UI in Settings (create/list/delete/pause-resume) | `packages/e2e/tests/ui/settings-scheduled-runs.test.ts` |
| F-UI-09: Agent profile health dashboard (empty/error states, provider capability display) | `packages/e2e/tests/ui/agent-profile-dashboard.test.ts` |
| F-UI-10: Graph view (dependency DAG, nodes, zoom, Show completed toggle) | `packages/e2e/tests/ui/graph-table-views.test.ts` |
| F-UI-10: Table view (sortable columns, status filter, row click to detail) | `packages/e2e/tests/ui/graph-table-views.test.ts` |
| F-UI-11: Board Stats Bar (status counts per column) | `packages/e2e/tests/ui/board-stats-bar.test.ts` |
| F-UI-11: Priority/type-based column sort | `packages/e2e/tests/ui/priority-sort.test.ts` |
| F-UI-12: Quick Tasks panel (keyboard 'q', built-in skills, custom prompt, context toggle, skill creation) | `packages/e2e/tests/ui/quick-tasks-panel.test.ts` |
| Markdown rendering in issue descriptions (detail panel view mode) | `packages/e2e/tests/ui/issue-description-markdown.test.ts` |
| Copy-to-clipboard for issue reference | `packages/e2e/tests/ui/copy-issue-reference.test.ts` |
| Hover quick-start buttons on issue cards | `packages/e2e/tests/ui/issue-card-hover-buttons.test.ts` |
| baseBranch + skill name display in workspace card | `packages/e2e/tests/ui/workspace-info.test.ts`, `packages/e2e/tests/ui/basebranch-skill-display.test.ts` |
| Ready for Merge badge (All Workspaces panel) | `packages/e2e/tests/ui/ready-for-merge-badge.test.ts` |
| AI Reviewed column conditional display + "Awaiting manual merge" hint | `packages/e2e/tests/ui/ai-reviewed-column.test.ts` |
| All Workspaces panel (filter chips, search, status badges, issue links) | `packages/e2e/tests/ui/all-workspaces-panel.test.ts` |
| Live session stats on issue cards (model name + context tokens) | `packages/e2e/tests/ui/session-stats.test.ts` |
| Agent task progress bar on issue cards (TodoProgress) | `packages/e2e/tests/ui/task-progress.test.ts` |
| Project script shortcuts (create via API, run from Scripts button, output/exit code) | `packages/e2e/tests/ui/project-scripts.test.ts` |
| Board Monitor toolbar (popover, Run Now, last-run display) | `packages/e2e/tests/ui/board-monitor-toolbar.test.ts` |
| Active-project recovery (stale-fallback, switching, reload hydration) | `packages/e2e/tests/ui/active-project-recovery.test.ts` |
| Codemod factory API (preview/apply with escape prevention, save/list CRUD) | `packages/e2e/tests/api/codemod.test.ts` |
| Session replay data contract (bare-array output, stream-json parsing, 404/empty) | `packages/e2e/tests/api/session-replay.test.ts` |
| Get-by-id contract (field presence / shape invariants across get-by-id routes) | `packages/e2e/tests/api/get-by-id-contract.test.ts` |
| F-DATA-02: Board WebSocket events (create/update/delete) | `packages/e2e/tests/api/board-events.test.ts`, `packages/e2e/tests/ui/board-realtime.test.ts` |
| F-DATA-03: Session history/output persistence + UI selector | `packages/e2e/tests/api/session-history.test.ts`, `packages/e2e/tests/ui/session-history.test.ts` |
| Preferences API (active-project get/set) | `packages/e2e/tests/api/preferences.test.ts` |
| Projects API (list, create, statuses, branches) | `packages/e2e/tests/api/projects.test.ts` |

### ❌ Not yet covered

Re-audited 2026-06-17. The previously-listed tickets #157, #158, #163, #167, #169, #170, #172, #173, #175, #176, #177, #178, #179, #182, #188, #189, #191, #193, #194, #196, #197 are now covered (see table above). Remaining gaps:

| Feature | Ticket |
|---------|--------|
| F-UI-06: In-app toast notifications (create/delete/merge success toasts, auto-dismiss) | #184 |
| F-WS-04: Direct workspace UI (purple badge, "Close"/"View Changes" vs "Merge"/"View Diff") — only basic Merge/View-Diff covered today | #195 |
| E2E: cover skip auto review toggle in issue detail edit | #174 |
| E2E: cover workspace setup scripts (F-WS-08) — distinct from project-script shortcuts already covered | #183 |
| E2E: cover blocked-by summary banner in issue detail panel | #185 |
| E2E: cover expand button for issue detail panel (full-width mode) | #190 |
| E2E: cover follow-up task creation in issue detail panel | #198 |
| E2E: cover auto-start follow-up tasks setting in Settings > Workflow — only the toggle's tab is covered | #199 |
| E2E: cover markdown preview toggle in issue description **edit** mode (distinct from #178 view render) | #203 |
| E2E: cover Open in VS Code button in workspace panel | #204 |
| E2E: cover issue artifacts API (create/list/delete attachments on issues) | #205 |
| E2E: cover Worktrees panel row actions (Open-in-Explorer, Delete) — bulk-clean covered, row actions not | #206 |
| E2E: cover graph view zoom-to-fit and table view Tags/Updated columns | #207 |
| Skeleton/loading state (`SkeletonBoard`) — delay board response, assert skeleton | #167-area |
| `POST /api/internal/board-notify` route-level test | (api) |
| `/ws/sessions/:sessionId` reconnect/error/close behavior | (api) |
| Unified `{ error }` response-shape contract across representative routes | (api) |


## Known Test Considerations

- **Windows git output**: Use `.trim()` for file content assertions (CRLF vs LF)
- **Session/workspace tests**: Use retry loops (3 attempts, 500ms–1s delays) for flaky worktree setup
- **Edit test uniqueness**: Use `Date.now()` suffixes to avoid accumulated data matching
- **E2E locator specificity**: Avoid `text=X` locators — use scoped selectors or `.first()`
- **Collapse/expand**: Archive column "Cancelled" text matches `button:has-text("Cancel")` — use regex `/^Cancel$/`
