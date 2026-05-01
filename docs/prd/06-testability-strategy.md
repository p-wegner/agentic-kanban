# PRD-06: Testability Strategy

## Philosophy
> If an AI can't test it, we can't ship it.

Every feature must be verifiable through automated tests that an AI agent can run, interpret, and use as feedback for iteration.

## Test Pyramid

```
         ┌──────────┐
         │   E2E    │  ← Playwright (user workflows)
         │  Tests   │
        ┌┴──────────┴┐
        │ Integration │  ← API + MCP + Git (cross-cutting)
        │   Tests     │
       ┌┴────────────┴┐
       │   API Tests   │  ← HTTP against real server
       └──────────────┘
      ┌┴──────────────┴┐
      │   Unit Tests    │  ← Pure logic, no I/O
      └────────────────┘
```

## Stage-Specific Test Plans

### Stage 1: Data Layer + API
**API Tests** (primary)
```python
# Example: pytest + httpx
def test_create_issue(client, project):
    response = client.post("/api/issues", json={
        "project_id": project.id,
        "title": "Fix login bug",
        "priority": "high"
    })
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Fix login bug"
    assert data["priority"] == "high"
    assert data["status"]["name"] == "Todo"  # default

def test_list_issues_by_status(client, project, issues_factory):
    issues_factory.create(status="todo", count=3)
    issues_factory.create(status="done", count=2)
    response = client.get("/api/issues?status=todo")
    assert len(response.json()) == 3

def test_update_issue_status(client, issue):
    response = client.patch(f"/api/issues/{issue.id}", json={
        "status": "in_progress"
    })
    assert response.status_code == 200
    # Verify in DB
    fresh = client.get(f"/api/issues/{issue.id}")
    assert fresh.json()["status"]["name"] == "In Progress"
```

### Stage 2: Kanban UI
**E2E Tests** (Playwright)
```python
def test_kanban_board_shows_columns(page, project_with_statuses):
    page.goto(f"/projects/{project_with_statuses.id}")
    columns = page.locator("[data-testid='kanban-column']")
    expect(columns).to_have_count(5)
    expect(columns.nth(0)).to_contain_text("Todo")

def test_drag_issue_between_columns(page, project, issue):
    page.goto(f"/projects/{project.id}")
    issue_card = page.locator(f"[data-issue-id='{issue.id}']")
    todo_column = page.locator("[data-status='todo']")
    in_progress_column = page.locator("[data-status='in_progress']")

    issue_card.drag_to(in_progress_column)

    # Verify API updated
    response = page.request.get(f"/api/issues/{issue.id}")
    assert response.json()["status"]["name"] == "In Progress"
```

### Stage 3: Workspace + Agent
**Integration Tests**
```python
def test_workspace_creates_git_branch(app, issue, tmp_git_repo):
    workspace = app.workspaces.create(
        issue_id=issue.id,
        repo_path=tmp_git_repo
    )
    assert workspace.branch.startswith("issue-")
    # Verify worktree exists
    assert Path(workspace.working_dir).exists()
    # Verify branch created
    repo = git.Repo(tmp_git_repo)
    assert workspace.branch in [b.name for b in repo.branches]

def test_claude_code_launches_in_workspace(app, workspace):
    session = app.sessions.start(
        workspace_id=workspace.id,
        executor="claude_code"
    )
    assert session.status == "running"
    # Wait for output
    time.sleep(2)
    assert len(session.output_lines) > 0
```

### Stage 4: MCP Integration
**MCP Protocol Tests**
```python
async def test_mcp_list_issues(mcp_client, project_with_issues):
    result = await mcp_client.call_tool("list_issues", {
        "project_id": project_with_issues.id
    })
    assert len(result.content) > 0
    issues = json.loads(result.content[0].text)
    assert all("title" in i for i in issues)

async def test_mcp_update_issue_status(mcp_client, issue):
    result = await mcp_client.call_tool("update_issue", {
        "issue_id": issue.id,
        "status": "in_progress"
    })
    # Verify via API
    api_issue = httpx.get(f"/api/issues/{issue.id}")
    assert api_issue.json()["status"]["name"] == "In Progress"
```

## AI-Driven Development Loop

### The Feedback Cycle
```
1. AI writes code
2. AI runs tests
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
- **Factory pattern**: `issue_factory.create(title="...", priority="high")`
- **Fixtures per test**: Each test gets a clean slate
- **Temp directories**: Git repos in temp dirs, cleaned up after test
- **In-memory DB option**: For unit tests, use in-memory SQLite

## CI/CD Integration
While this is a personal project, the test suite should be runnable:
- **Locally**: `pytest` / `playwright test`
- **Pre-commit**: Run fast tests before each commit
- **Full suite**: Run all tests including E2E before merging

## Testing Tools Recommendation

| Tool | Purpose |
|------|---------|
| **pytest** | Unit + API + integration tests |
| **Playwright** | E2E browser tests |
| **httpx** | HTTP client for API tests |
| **factory_boy** | Test data factories |
| **freezegun** | Time mocking |
| **tmp_path** (pytest) | Temporary directories |
