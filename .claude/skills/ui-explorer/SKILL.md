---
name: ui-explorer
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
description: Visual UI exploration: find feature gaps, create tickets, fix stale docs about the featureset. Sources of truth are CLAUDE.md (operational) and docs/prd/01-features-catalog.md (catalog).
---

You are a UI explorer, product thinker, and documentation maintainer. Your job is to:
1. Systematically click through the running app with a headed browser
2. Compare what you find against the documented feature set
3. Create tickets for gaps and improvements
4. Fix stale or incomplete documentation — in parallel using a subagent

## Sources of Truth

Two files define what features exist and are verified:

| File | Role | Update when |
|------|------|-------------|
| `CLAUDE.md` → "Project Status" bullet list | **Operational truth** — what every agent session reads | A feature is visually verified or removed |
| `docs/prd/01-features-catalog.md` | **Feature catalog** — structured F-XXX entries with status | A feature's scope or status changes |

Read both files before starting the browser. They tell you what *should* be in the UI — use them as your checklist during exploration.

## Phase 0: Load Baseline

Before opening the browser:

```
Read CLAUDE.md         → extract the "Project Status" bullet list
Read docs/prd/01-features-catalog.md  → note all DONE/SKIP/NOT PLANNED entries
```

Build a mental (or written) checklist:
- Features marked DONE → must appear in UI
- Features marked SKIP → must NOT appear
- Features NOT in either doc → candidate for new catalog entry
=======
=======
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
description: Visual UI exploration: open headed browser, identify feature gaps, create tickets, wire up dependencies, verify in graph view
---

You are a UI explorer and product thinker. Your job is to click through the running app with a headed browser, identify missing or improvable features, create tickets for them, and wire up logical dependencies so the graph view is meaningful.
<<<<<<< HEAD
>>>>>>> 741e4c0 (chore: add exported agent skills to .claude/skills/)
=======
description: Visual UI exploration: find feature gaps, create tickets, fix stale docs about the featureset. Sources of truth are CLAUDE.md (operational) and docs/prd/01-features-catalog.md (catalog).
---

=======
description: Visual UI exploration: find feature gaps, create tickets, fix stale docs about the featureset. Sources of truth are CLAUDE.md (operational) and docs/prd/01-features-catalog.md (catalog).
---

>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
You are a UI explorer, product thinker, and documentation maintainer. Your job is to:
1. Systematically click through the running app with a headed browser
2. Compare what you find against the documented feature set
3. Create tickets for gaps and improvements
4. Fix stale or incomplete documentation — in parallel using a subagent

## Sources of Truth

Two files define what features exist and are verified:

| File | Role | Update when |
|------|------|-------------|
| `CLAUDE.md` → "Project Status" bullet list | **Operational truth** — what every agent session reads | A feature is visually verified or removed |
| `docs/prd/01-features-catalog.md` | **Feature catalog** — structured F-XXX entries with status | A feature's scope or status changes |

Read both files before starting the browser. They tell you what *should* be in the UI — use them as your checklist during exploration.

## Phase 0: Load Baseline

Before opening the browser:

```
Read CLAUDE.md         → extract the "Project Status" bullet list
Read docs/prd/01-features-catalog.md  → note all DONE/SKIP/NOT PLANNED entries
```

Build a mental (or written) checklist:
- Features marked DONE → must appear in UI
- Features marked SKIP → must NOT appear
- Features NOT in either doc → candidate for new catalog entry
<<<<<<< HEAD
>>>>>>> 66d2706 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
=======
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)

## Phase 1: Visual Exploration

Determine the correct client URL:
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
- Read `$env:KANBAN_CLIENT_PORT` — if set, use `http://localhost:$env:KANBAN_CLIENT_PORT`
=======
- Read `$env:KANBAN_CLIENT_PORT` - if set, use `http://localhost:$env:KANBAN_CLIENT_PORT`
>>>>>>> 741e4c0 (chore: add exported agent skills to .claude/skills/)
=======
- Read `$env:KANBAN_CLIENT_PORT` — if set, use `http://localhost:$env:KANBAN_CLIENT_PORT`
>>>>>>> 66d2706 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
=======
- Read `$env:KANBAN_CLIENT_PORT` - if set, use `http://localhost:$env:KANBAN_CLIENT_PORT`
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
=======
- Read `$env:KANBAN_CLIENT_PORT` — if set, use `http://localhost:$env:KANBAN_CLIENT_PORT`
>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
- Otherwise default to `http://localhost:5173`

Open the browser in headed mode so the user can watch:
```
playwright-cli open --headed <url>
```

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
Wait for the board to fully load (poll with `playwright-cli screenshot` until issue cards render — the skeleton state looks identical to the loaded state visually, but the DOM contains real text).

Click through every major surface in order:

1. **Board view** — columns, issue cards, stat bar, Blocked filter, Tasks panel, view switcher (Board/Graph/Table)
2. **Issue cards** — priority badges, workspace badge, tag badges, task progress bar, live session stats, hover actions
3. **Issue detail panel** — title, description, status dropdown, priority, estimate, workspaces, tags, dependencies, timestamps, follow-up task button, Expand button
4. **Issue edit mode** — all editable fields, Enhance button, Save/Cancel
5. **Workspace panel** — repo info, branch, session status, Output/Summary tabs, terminal view, chat input, action buttons (Resume, Update Base, Terminal, Review, View Diff, Merge, Delete), inline diff viewer
6. **Graph view** — dependency arrows, node colors by status, "Show completed" toggle, zoom controls, status legend
7. **Table view** — columns (#, Title, Status, Priority, Estimate, Created), status filter, row clicks
8. **Settings modal (all 8 tabs)** — Agent, Workflow, Skills, MCP Tools, UI, Project, Tags, Advanced
9. **All Workspaces panel** — workspace list, issue links, diff stats, active count
10. **Worktrees panel** — worktree list, badges (main/direct/idle), issue links, copy-path button
11. **Tasks panel (Quick Tasks)** — skill list, custom task prompt, context button
12. **Command palette** — Ctrl+K via `page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true})))`
13. **Keyboard shortcuts overlay** — `?` key

Take screenshots at each step. Cross-reference each feature you see against your Phase 0 checklist. Note:
- **Undocumented**: feature visible in UI but absent from CLAUDE.md or catalog
- **Stale**: feature documented with wrong details (e.g. wrong tab names, wrong button labels)
- **Missing**: feature marked DONE in docs but not found in UI (potential regression)
- **Improvable**: feature exists but has UX friction, empty states, or missing actions

## Phase 2: Gap Analysis

After exploration, produce two lists:

### Doc Gaps (for Phase 3 subagent)
Features found in the UI that are undocumented or incorrectly documented. For each:
- Which file needs updating (CLAUDE.md, catalog, or both)
- Exact bullet or F-entry to add/correct
- The correct description based on what you observed

### Feature Gaps (for Phase 4 tickets)
UX/feature improvements identified during exploration. For each:
- What is missing or painful
- How small/large (xs/s/m/l)
- Which existing pattern to follow

Aim for 4–8 feature gaps, mixing quick wins (xs/s) and bigger items (m/l).

## Phase 3: Fix Docs (Subagent)

Spawn a documentation subagent using the Agent tool. Hand it the full doc-gap list from Phase 2 so it can work in parallel with Phase 4.

The subagent should:
1. Update `docs/prd/01-features-catalog.md`:
   - Replace the `<!-- last-synced: ... | commit: ... -->` line at the top with the current timestamp and short SHA (`git rev-parse --short HEAD`)
<<<<<<< HEAD
   - Fix stale F-entry descriptions (e.g. wrong tab names, missing fields)
   - Add new F-entries for undocumented features with status DONE
   - Keep the existing structure: `### F-CAT-NN: Feature Name` with bullet list + `**Status: DONE**`
2. Update the `CLAUDE.md` "Project Status" bullet list:
   - Update the "visually verified (DATE)" line to today's date
   - Add bullets for verified features missing from the list
   - Correct any bullet that describes the UI wrongly
   - Keep bullets concise — one line per feature with key sub-bullets

Prompt template for the subagent:
```
You are a documentation maintainer for the agentic-kanban project. Two files define the feature set:
- CLAUDE.md (Project Status bullet list) — operational truth for agents
- docs/prd/01-features-catalog.md — structured feature catalog

Read both files now. Then apply the following doc fixes identified during a UI exploration session:

[INSERT YOUR DOC GAP LIST HERE]

Rules:
- Do not change features marked SKIP or NOT PLANNED
- Do not invent details you weren't given — use only what was observed
- Keep the existing structure and formatting in each file
- In docs/prd/01-features-catalog.md, update the <!-- last-synced --> comment at
  the top to today's ISO 8601 date+time and the short commit SHA from `git rev-parse --short HEAD`
- In CLAUDE.md, update the "visually verified (DATE)" line to today's date
- After editing both files, commit the changes with message "docs: sync feature catalog and CLAUDE.md from UI exploration"
```

## Phase 4: Create Tickets

For each feature gap from Phase 2, create a ticket using `mcp__agentic-kanban__create_issue`:
- Title: short, imperative, specific
- Description: ## What / ## Why / ## Acceptance Criteria sections
- Priority: xs/s → low/medium, m/l → medium/high
- Estimate: set the estimate field (XS/S/M/L/XL) matching your size assessment

Use `mcp__agentic-kanban__update_issue` if the create call doesn't accept description directly.

## Phase 5: Wire Dependencies

Analyze tickets for genuine technical ordering:
- Y builds directly on X's output (e.g. "add table view" before "add keyboard shortcut for table view")
- X and Y touch the same DB migration or shared schema

Use `POST http://localhost:3001/api/issues/:id/dependencies` with body:
```json
{ "dependsOnId": "<id>", "type": "depends_on", "reason": "..." }
```

Avoid adding dependencies just because tickets are topically related.

## Phase 6: Verify in Graph View

Switch to Graph view in the browser. Take a final screenshot. Check:
- All new tickets appear as nodes
- Dependency arrows render correctly
- No new ticket is an isolated node without good reason
=======
=======
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
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
<<<<<<< HEAD
=======
Wait for the board to fully load (poll with `playwright-cli screenshot` until issue cards render — the skeleton state looks identical to the loaded state visually, but the DOM contains real text).
>>>>>>> 66d2706 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)

Click through every major surface in order:

1. **Board view** — columns, issue cards, stat bar, Blocked filter, Tasks panel, view switcher (Board/Graph/Table)
2. **Issue cards** — priority badges, workspace badge, tag badges, task progress bar, live session stats, hover actions
3. **Issue detail panel** — title, description, status dropdown, priority, estimate, workspaces, tags, dependencies, timestamps, follow-up task button, Expand button
4. **Issue edit mode** — all editable fields, Enhance button, Save/Cancel
5. **Workspace panel** — repo info, branch, session status, Output/Summary tabs, terminal view, chat input, action buttons (Resume, Update Base, Terminal, Review, View Diff, Merge, Delete), inline diff viewer
6. **Graph view** — dependency arrows, node colors by status, "Show completed" toggle, zoom controls, status legend
7. **Table view** — columns (#, Title, Status, Priority, Estimate, Created), status filter, row clicks
8. **Settings modal (all 8 tabs)** — Agent, Workflow, Skills, MCP Tools, UI, Project, Tags, Advanced
9. **All Workspaces panel** — workspace list, issue links, diff stats, active count
10. **Worktrees panel** — worktree list, badges (main/direct/idle), issue links, copy-path button
11. **Tasks panel (Quick Tasks)** — skill list, custom task prompt, context button
12. **Command palette** — Ctrl+K via `page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true})))`
13. **Keyboard shortcuts overlay** — `?` key

Take screenshots at each step. Cross-reference each feature you see against your Phase 0 checklist. Note:
- **Undocumented**: feature visible in UI but absent from CLAUDE.md or catalog
- **Stale**: feature documented with wrong details (e.g. wrong tab names, wrong button labels)
- **Missing**: feature marked DONE in docs but not found in UI (potential regression)
- **Improvable**: feature exists but has UX friction, empty states, or missing actions

## Phase 2: Gap Analysis

After exploration, produce two lists:

### Doc Gaps (for Phase 3 subagent)
Features found in the UI that are undocumented or incorrectly documented. For each:
- Which file needs updating (CLAUDE.md, catalog, or both)
- Exact bullet or F-entry to add/correct
- The correct description based on what you observed

### Feature Gaps (for Phase 4 tickets)
UX/feature improvements identified during exploration. For each:
- What is missing or painful
- How small/large (xs/s/m/l)
- Which existing pattern to follow

Aim for 4–8 feature gaps, mixing quick wins (xs/s) and bigger items (m/l).

## Phase 3: Fix Docs (Subagent)

Spawn a documentation subagent using the Agent tool. Hand it the full doc-gap list from Phase 2 so it can work in parallel with Phase 4.

The subagent should:
1. Update `docs/prd/01-features-catalog.md`:
=======
>>>>>>> 702afdb (docs: add last-synced timestamp+SHA header to feature catalog)
   - Fix stale F-entry descriptions (e.g. wrong tab names, missing fields)
   - Add new F-entries for undocumented features with status DONE
   - Keep the existing structure: `### F-CAT-NN: Feature Name` with bullet list + `**Status: DONE**`
2. Update the `CLAUDE.md` "Project Status" bullet list:
   - Update the "visually verified (DATE)" line to today's date
   - Add bullets for verified features missing from the list
   - Correct any bullet that describes the UI wrongly
   - Keep bullets concise — one line per feature with key sub-bullets

Prompt template for the subagent:
```
You are a documentation maintainer for the agentic-kanban project. Two files define the feature set:
- CLAUDE.md (Project Status bullet list) — operational truth for agents
- docs/prd/01-features-catalog.md — structured feature catalog

Read both files now. Then apply the following doc fixes identified during a UI exploration session:

[INSERT YOUR DOC GAP LIST HERE]

Rules:
- Do not change features marked SKIP or NOT PLANNED
- Do not invent details you weren't given — use only what was observed
- Keep the existing structure and formatting in each file
- In docs/prd/01-features-catalog.md, update the <!-- last-synced --> comment at
  the top to today's ISO 8601 date+time and the short commit SHA from `git rev-parse --short HEAD`
- In CLAUDE.md, update the "visually verified (DATE)" line to today's date
- After editing both files, commit the changes with message "docs: sync feature catalog and CLAUDE.md from UI exploration"
```

<<<<<<< HEAD
Switch to Graph view in the browser and take a final screenshot to confirm the dependency arrows render correctly. If any node is isolated (no edges), consider whether it genuinely stands alone or a dependency was missed.
>>>>>>> 741e4c0 (chore: add exported agent skills to .claude/skills/)
=======
## Phase 4: Create Tickets

For each feature gap from Phase 2, create a ticket using `mcp__agentic-kanban__create_issue`:
- Title: short, imperative, specific
- Description: ## What / ## Why / ## Acceptance Criteria sections
- Priority: xs/s → low/medium, m/l → medium/high
- Estimate: set the estimate field (XS/S/M/L/XL) matching your size assessment

Use `mcp__agentic-kanban__update_issue` if the create call doesn't accept description directly.

## Phase 5: Wire Dependencies

Analyze tickets for genuine technical ordering:
- Y builds directly on X's output (e.g. "add table view" before "add keyboard shortcut for table view")
- X and Y touch the same DB migration or shared schema

Use `POST http://localhost:3001/api/issues/:id/dependencies` with body:
```json
{ "dependsOnId": "<id>", "type": "depends_on", "reason": "..." }
```

Avoid adding dependencies just because tickets are topically related.

## Phase 6: Verify in Graph View

Switch to Graph view in the browser. Take a final screenshot. Check:
- All new tickets appear as nodes
- Dependency arrows render correctly
- No new ticket is an isolated node without good reason
>>>>>>> 66d2706 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
=======
=======
Wait for the board to fully load (poll with `playwright-cli screenshot` until issue cards render — the skeleton state looks identical to the loaded state visually, but the DOM contains real text).
>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)

Click through every major surface in order:

1. **Board view** — columns, issue cards, stat bar, Blocked filter, Tasks panel, view switcher (Board/Graph/Table)
2. **Issue cards** — priority badges, workspace badge, tag badges, task progress bar, live session stats, hover actions
3. **Issue detail panel** — title, description, status dropdown, priority, estimate, workspaces, tags, dependencies, timestamps, follow-up task button, Expand button
4. **Issue edit mode** — all editable fields, Enhance button, Save/Cancel
5. **Workspace panel** — repo info, branch, session status, Output/Summary tabs, terminal view, chat input, action buttons (Resume, Update Base, Terminal, Review, View Diff, Merge, Delete), inline diff viewer
6. **Graph view** — dependency arrows, node colors by status, "Show completed" toggle, zoom controls, status legend
7. **Table view** — columns (#, Title, Status, Priority, Estimate, Created), status filter, row clicks
8. **Settings modal (all 8 tabs)** — Agent, Workflow, Skills, MCP Tools, UI, Project, Tags, Advanced
9. **All Workspaces panel** — workspace list, issue links, diff stats, active count
10. **Worktrees panel** — worktree list, badges (main/direct/idle), issue links, copy-path button
11. **Tasks panel (Quick Tasks)** — skill list, custom task prompt, context button
12. **Command palette** — Ctrl+K via `page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true})))`
13. **Keyboard shortcuts overlay** — `?` key

Take screenshots at each step. Cross-reference each feature you see against your Phase 0 checklist. Note:
- **Undocumented**: feature visible in UI but absent from CLAUDE.md or catalog
- **Stale**: feature documented with wrong details (e.g. wrong tab names, wrong button labels)
- **Missing**: feature marked DONE in docs but not found in UI (potential regression)
- **Improvable**: feature exists but has UX friction, empty states, or missing actions

## Phase 2: Gap Analysis

After exploration, produce two lists:

### Doc Gaps (for Phase 3 subagent)
Features found in the UI that are undocumented or incorrectly documented. For each:
- Which file needs updating (CLAUDE.md, catalog, or both)
- Exact bullet or F-entry to add/correct
- The correct description based on what you observed

### Feature Gaps (for Phase 4 tickets)
UX/feature improvements identified during exploration. For each:
- What is missing or painful
- How small/large (xs/s/m/l)
- Which existing pattern to follow

Aim for 4–8 feature gaps, mixing quick wins (xs/s) and bigger items (m/l).

## Phase 3: Fix Docs (Subagent)

Spawn a documentation subagent using the Agent tool. Hand it the full doc-gap list from Phase 2 so it can work in parallel with Phase 4.

The subagent should:
1. Update `docs/prd/01-features-catalog.md`:
   - Fix stale F-entry descriptions (e.g. wrong tab names, missing fields)
   - Add new F-entries for undocumented features with status DONE
   - Keep the existing structure: `### F-CAT-NN: Feature Name` with bullet list + `**Status: DONE**`
2. Update the `CLAUDE.md` "Project Status" bullet list:
   - Add bullets for verified features missing from the list
   - Correct any bullet that describes the UI wrongly
   - Keep bullets concise — one line per feature with key sub-bullets

Prompt template for the subagent:
```
You are a documentation maintainer for the agentic-kanban project. Two files define the feature set:
- CLAUDE.md (Project Status bullet list) — operational truth for agents
- docs/prd/01-features-catalog.md — structured feature catalog

Read both files now. Then apply the following doc fixes identified during a UI exploration session:

[INSERT YOUR DOC GAP LIST HERE]

Rules:
- Do not change features marked SKIP or NOT PLANNED
- Do not invent details you weren't given — use only what was observed
- Keep the existing structure and formatting in each file
- After editing both files, commit the changes with message "docs: sync feature catalog and CLAUDE.md from UI exploration"
```

<<<<<<< HEAD
Switch to Graph view in the browser and take a final screenshot to confirm the dependency arrows render correctly. If any node is isolated (no edges), consider whether it genuinely stands alone or a dependency was missed.
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
=======
## Phase 4: Create Tickets

For each feature gap from Phase 2, create a ticket using `mcp__agentic-kanban__create_issue`:
- Title: short, imperative, specific
- Description: ## What / ## Why / ## Acceptance Criteria sections
- Priority: xs/s → low/medium, m/l → medium/high
- Estimate: set the estimate field (XS/S/M/L/XL) matching your size assessment

Use `mcp__agentic-kanban__update_issue` if the create call doesn't accept description directly.

## Phase 5: Wire Dependencies

Analyze tickets for genuine technical ordering:
- Y builds directly on X's output (e.g. "add table view" before "add keyboard shortcut for table view")
- X and Y touch the same DB migration or shared schema

Use `POST http://localhost:3001/api/issues/:id/dependencies` with body:
```json
{ "dependsOnId": "<id>", "type": "depends_on", "reason": "..." }
```

Avoid adding dependencies just because tickets are topically related.

## Phase 6: Verify in Graph View

Switch to Graph view in the browser. Take a final screenshot. Check:
- All new tickets appear as nodes
- Dependency arrows render correctly
- No new ticket is an isolated node without good reason
>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)

## Clean Up

- Close the browser: `playwright-cli close`
- Delete any `.png` screenshots created during the session
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 66d2706 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
=======
>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
- Report a three-part summary:
  1. **Doc fixes**: files updated + what changed
  2. **Tickets created**: list with #N, title, estimate
  3. **Dependency edges**: X → depends_on → Y
<<<<<<< HEAD
<<<<<<< HEAD
=======
- Report: list of created tickets with numbers, titles, and the dependency edges added
>>>>>>> 741e4c0 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> 66d2706 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
=======
- Report: list of created tickets with numbers, titles, and the dependency edges added
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> 9ee4d48 (docs: improve ui-explorer skill + sync feature catalog from UI exploration)
