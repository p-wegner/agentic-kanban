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
- 76 tests covering: tags CRUD, preferences, issue numbers, API routes, git service

### E2E Tests (Playwright)
- Run via `pnpm test:e2e`
- Full server + client startup via global setup
- Tests create their own data, no shared state dependencies
- 101 tests covering: API endpoints, UI interactions, MCP tools, board events, sessions

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
pnpm --filter @agentic-kanban/server test    # Unit tests (76 tests)
pnpm test:e2e                                  # E2E tests (101 tests)
```

## Current E2E Coverage

### ✅ Covered features

| Feature | Test file(s) |
|---------|-------------|
| F-TASK-01: Issues CRUD (create/update/delete, estimate) | `packages/server/src/__tests__/api.test.ts`, `packages/e2e/tests/api/issues.test.ts` |
| F-TASK-02: Kanban board view, inline create, detail panel, drag-drop | `packages/e2e/tests/ui/board.test.ts` |
| F-TASK-02: Collapsible archive column group (Done/Cancelled) | `packages/e2e/tests/ui/archive-columns.test.ts` |
| F-TASK-03: Real-time search, priority filter | `packages/e2e/tests/ui/search.test.ts` |
| F-TASK-04: Tags CRUD + assignment to issues (API) | `packages/e2e/tests/api/tags.test.ts` |
| F-TASK-04: Tags management via Settings > Tags tab UI (rename, delete, add, merge, color) | `packages/e2e/tests/ui/settings-tags.test.ts` |
| F-WS-01/03: Workspace creation, board workspace summary | `packages/e2e/tests/api/workspaces.test.ts`, `packages/e2e/tests/api/board-workspace-summary.test.ts` |
| F-WS-02: Agent session lifecycle, launch/stop, output persistence | `packages/e2e/tests/api/workspace-lifecycle.test.ts`, `packages/e2e/tests/api/session-history.test.ts` |
| F-WS-02: Stream-json output parsing UI | `packages/e2e/tests/output-parser.spec.ts` |
| F-WS-02: Mock agent profiles (standard/multi-turn/error/delay) | `packages/e2e/tests/api/mock-agent-profiles.test.ts` |
| F-WS-04: Git branch creation for workspaces | `packages/e2e/tests/api/workspaces.test.ts` |
| F-WS-05: Workspace deletion | `packages/e2e/tests/api/workspaces.test.ts` |
| F-REV-01: Diff viewer UI (file tree, diff lines, unified/split view, real diff content) | `packages/e2e/tests/ui/diff-viewer.test.ts` |
| F-REV-02: Diff comments API (create/edit/delete/filter) + inline comment UI (CRUD via diff viewer) | `packages/server/src/__tests__/api.test.ts`, `packages/e2e/tests/ui/diff-viewer.test.ts` |
| F-MCP-01: MCP server tools (get_context, list/create/update/get_issue, list_workspaces, active-project resolution) | `packages/mcp-server/src/__tests__/mcp-tools.test.ts` |
| F-MCP-03: Agent command configuration via settings | `packages/e2e/tests/api/settings.test.ts` |
| F-MCP-04: Agent Skills UI in Settings (built-in protection, custom skill CRUD, edit/delete) | `packages/e2e/tests/ui/agent-skills.test.ts` |
| F-MCP-04: Skill selector in inline issue create form (Start Workspace checkbox) | `packages/e2e/tests/ui/agent-skills.test.ts` |
| F-DATA-02: Board WebSocket events (create/update/delete) | `packages/e2e/tests/api/board-events.test.ts`, `packages/e2e/tests/ui/board-realtime.test.ts` |
| F-DATA-03: Session history/output persistence + UI selector | `packages/e2e/tests/api/session-history.test.ts`, `packages/e2e/tests/ui/session-history.test.ts` |
| F-UI-01: Register project / Create project UI | `packages/e2e/tests/ui/register-project.test.ts` |
| F-UI-03: Command palette (Ctrl+K, filter, navigate, execute) | `packages/e2e/tests/ui/command-palette.test.ts` |
| F-UI-04: Keyboard shortcuts (? overlay, Escape, `/` search) | `packages/e2e/tests/ui/shortcuts.test.ts` |
| F-UI-09: Settings panel (agent command, mock agent toggle, persist) | `packages/e2e/tests/ui/settings.test.ts`, `packages/e2e/tests/api/settings.test.ts` |
| F-UI-02: Workspace panel open, diff view, merge | `packages/e2e/tests/ui/workspace.test.ts` |
| F-UI-02: Workspace panel chat input / multi-turn interaction (Send/Stop, Ctrl+Enter, turn state) | `packages/e2e/tests/ui/workspace-chat.test.ts` |
| F-UI-08: Expandable issue creation panel (full-screen form, plan mode, skip review checkboxes) | `packages/e2e/tests/ui/expandable-create-panel.test.ts` |
| Preferences API (active-project get/set) | `packages/e2e/tests/api/preferences.test.ts` |
| Projects API (list, create, statuses, branches) | `packages/e2e/tests/api/projects.test.ts` |

### ❌ Not yet covered

| Feature | Ticket |
|---------|--------|
| F-TASK-05: Issue dependencies/relationships UI (add/remove dep badges, cycle detection, Analyze Deps) | #163 |
| F-TASK-05: Blocked-by summary banner in issue detail panel (blocked by N issues count) | #185 |
| F-REV-03: AI code review flow (manual review button, reviewing badge, session output) | #165 |
| F-UI-07: Worktree Overview panel (branch icon, worktree list, issue link nav) | #158 |
| F-UI-07: Orphaned worktree identification and bulk-clean in Worktrees panel | #172 |
| F-UI-10: Graph view (dependency DAG, nodes, zoom, Show completed toggle) | #166 |
| F-UI-10: Table view (sortable columns, status filter, row click to detail) | #166 |
| F-UI-11: Board stats bar (status counts, commits counter, Blocked filter toggle) | #167 |
| F-UI-11: Priority-based sort for board columns | #170 |
| F-UI-12: Quick Tasks panel (skill list, custom prompt input) | #157 |
| F-UI-06: In-app toast notifications (create/delete/merge success toasts, auto-dismiss) | #184 |
| F-UI-03: Review and Merge actions in command palette (workspace-scoped, disabled state) | #182 |
| F-UI-02: baseBranch and skill name display in workspace panel | #176 |
| F-UI-02: Ready for Merge badge in workspace and All Workspaces panels | #173 |
| F-WS-08: Workspace setup scripts (API persistence, Settings UI, blocking mode toggle) | #183 |
| All Workspaces panel (filter, search, bulk close idle, workspace list grouped by issue) | #169 |
| Skip auto review toggle in issue detail edit mode | #174 |
| Hover quick-start buttons on issue cards (Start Workspace / Resume) | #175 |
| Copy-to-clipboard for issue reference (#N) in detail panel | #177 |
| Markdown rendering in issue descriptions (detail panel view mode) | #178 |
| Scheduled Runs UI in Settings panel (create/list/delete scheduled runs) | #179 |
| F-UI-04: View-switching keyboard shortcuts (b=Board, g=Graph, t=Table, q=Quick Tasks) | #188 |
| F-UI-09: Board monitor visualization panel and workflow toggles (Settings > Workflow) | #189 |
| F-UI-02: Expand button for issue detail panel (full-width mode) | #190 |
| F-UI-02: AI Reviewed column conditional display and "Awaiting manual merge" hint | #191 |
| F-UI-09: "Enhance with AI" button for skill creation/editing in Settings > Skills tab | #192 |
| F-WS-02: Live session stats on issue cards (real-time model name + context token count via WebSocket) | #193 |
| F-WS-02: Agent task progress bar on issue cards (TodoProgress N/M tasks + K active) | #194 |
| F-WS-04: Direct workspace UI (purple badge, "Close"/"View Changes" vs "Merge"/"View Diff") | #195 |
| F-TASK-01: "Enhance with AI" button in issue edit panel (AI-powered title/description improvement) | #196 |

## Known Test Considerations

- **Windows git output**: Use `.trim()` for file content assertions (CRLF vs LF)
- **Session/workspace tests**: Use retry loops (3 attempts, 500ms–1s delays) for flaky worktree setup
- **Edit test uniqueness**: Use `Date.now()` suffixes to avoid accumulated data matching
- **E2E locator specificity**: Avoid `text=X` locators — use scoped selectors or `.first()`
- **Collapse/expand**: Archive column "Cancelled" text matches `button:has-text("Cancel")` — use regex `/^Cancel$/`
