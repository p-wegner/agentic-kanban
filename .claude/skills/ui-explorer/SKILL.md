---
name: ui-explorer
description: Visual UI exploration: open headed browser, identify feature gaps, create tickets, wire up dependencies, verify in graph view
---

You are a UI explorer and product thinker. Your job is to click through the running app with a headed browser, identify missing or improvable features, create tickets for them, and wire up logical dependencies so the graph view is meaningful.

## Phase 1: Visual Exploration

Determine the correct client URL:
- Read `$env:KANBAN_CLIENT_PORT` - if set, use `http://localhost:$env:KANBAN_CLIENT_PORT`
- Otherwise default to `http://localhost:5173`

Open the browser in headed mode so the user can watch:
```
playwright-cli open --headed <url>
```

Click through every major surface systematically:
1. **Board view** - columns, issue cards, card details, inline create form
2. **Issue detail panel** - all fields, edit mode, workspace list, tags, follow-up task
3. **Workspace panel** - session history, diff stats, chat input, action buttons
4. **Graph view** - dependency arrows, node clicks, zoom controls
5. **Settings modal** - every tab: Agent, Workflow, Skills, MCP Tools, UI, Project, Advanced
6. **Tasks panel** - skill list, custom task prompt, context button
7. **Worktrees panel** - worktree list, status badges
8. **Command palette** - Ctrl+K (dispatch via `page.evaluate(() => window.dispatchEvent(...))`)
9. **Keyboard shortcut help** - `?` key

Take screenshots at each step. Look for:
- Missing fields (e.g. due date, estimate, assignee)
- Actions that exist in the API/MCP but have no UI surface
- Flows that require too many clicks
- Information shown in the API response but not rendered
- Empty states that could be more helpful
- Settings that exist but have no effect or no feedback

## Phase 2: Ideation

After exploring, synthesize 4-8 distinct feature ideas. For each, note:
- What is missing or painful
- How small/large the change is (xs/s/m/l)
- Which existing patterns to follow (e.g. "same as the Expand button on the create form")

Aim for a mix of quick wins (xs/s) and bigger features (m/l).

## Phase 3: Create Tickets

For each idea, create a ticket using `mcp__agentic-kanban__create_issue`:
- Title: short, imperative, specific (e.g. "Add estimate field to issue detail panel")
- Description: include What, Why, and Acceptance Criteria sections
- Priority: match effort - xs/s ? low/medium, m/l ? medium/high

Use `mcp__agentic-kanban__update_issue` after creation to add a structured description if the create call does not support it directly.

## Phase 4: Add Dependencies

Analyze the created tickets for genuine technical ordering:
- X must be done before Y if Y builds on X's output (e.g. "expanded panel" before "show estimate in expanded panel")
- X must be done before Y if they touch the same DB schema/migration
- Avoid adding dependencies just because tickets are topically related

Use `mcp__agentic-kanban__add_dependency` (or `POST /api/issues/:id/dependencies` with body `{ "dependsOnId": "<id>", "type": "depends_on", "reason": "..." }`) to wire them up.

## Phase 5: Verify in Graph View

Switch to Graph view in the browser and take a final screenshot to confirm the dependency arrows render correctly. If any node is isolated (no edges), consider whether it genuinely stands alone or a dependency was missed.

## Clean Up

- Close the browser: `playwright-cli close`
- Delete any `.png` screenshots created during the session
- Report: list of created tickets with numbers, titles, and the dependency edges added