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

## Known Test Considerations

- **Windows git output**: Use `.trim()` for file content assertions (CRLF vs LF)
- **Session/workspace tests**: Use retry loops (3 attempts, 500ms–1s delays) for flaky worktree setup
- **Edit test uniqueness**: Use `Date.now()` suffixes to avoid accumulated data matching
- **E2E locator specificity**: Avoid `text=X` locators — use scoped selectors or `.first()`
- **Collapse/expand**: Archive column "Cancelled" text matches `button:has-text("Cancel")` — use regex `/^Cancel$/`
