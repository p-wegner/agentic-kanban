---
name: ui-review
description: UI/UX review — spawns parallel agents to explore the running UI, identifies styling, workflow, and usability improvements, and creates kanban tickets
---

You are a senior UI/UX reviewer. Your goal is to explore the running application, identify the highest-impact usability and visual improvements, and create actionable kanban tickets.

## Process

### Step 0: Start the dev server

If the app is not already running, start it. Check if the server port is already listening before launching. Once running, note the client URL (typically localhost with the appropriate port).

### Step 1: Parallel UI Exploration

Launch 5 Explore subagents in parallel, each analyzing a different UI/UX dimension. Each subagent should explore the running app using playwright-cli (navigate pages, click buttons, fill forms, take screenshots) AND read component source files where needed.

**1. Visual consistency agent** — Check styling and visual polish:
- Inconsistent spacing, padding, margins across similar components
- Color palette drift — different shades used for the same semantic role
- Font size/weight inconsistencies in headings, labels, body text
- Button styles that don't match (different radii, padding, shadows)
- Alignment issues — text, icons, form elements not lining up
- Dark mode rendering issues — check contrast, unreadable text, broken backgrounds

**2. Workflow & interaction agent** — Find friction in common flows:
- Tasks that require too many clicks or page navigations
- Missing keyboard shortcuts for frequent actions
- Forms that don't validate until submit (instead of inline)
- Actions with no loading state, success feedback, or error feedback
- Destructive actions without confirmation dialogs
- Missing undo/cancel for reversible operations
- Context loss — navigating away and losing unsaved state

**3. Information architecture agent** — Check how data is presented:
- Important information buried or hard to find
- Overwhelming dense data that needs progressive disclosure
- Missing or unclear empty states
- Lists/tables that lack sorting, filtering, or search
- Status indicators that are ambiguous or color-only (no text/icon fallback)
- Timestamps or metadata that are hidden or hard to discover

**4. Component & layout agent** — Check responsive and structural issues:
- Layout breaks at different viewport sizes or content lengths
- Overflow/truncation issues — text cut off, scrollbars where they shouldn't be
- Modals or panels that don't scroll properly for long content
- Fixed-width elements that don't adapt
- Z-index issues — tooltips, dropdowns, or modals behind other elements
- Inconsistent use of panels vs modals vs inline for similar interactions

**5. Accessibility & error handling agent** — Check robustness:
- Missing or unclear labels on form fields and buttons
- Icon-only buttons without tooltips or aria labels
- Focus management — focus lost, trapped, or not redirected after actions
- Error messages that are vague ("Something went wrong") or technical (stack traces)
- Silent failures — actions that fail with no user-visible feedback
- `.catch(() => {})` patterns in the code that swallow errors

Each agent must report specific component names, file paths, and screenshots where relevant.

### Step 2: Synthesize Findings

Collect all subagent reports. For each finding, assess:
- **User impact**: How many users hit this? How annoying is it? (High / Medium / Low)
- **Effort**: How much work to fix? (Quick fix / Small task / Larger refactor)
- **Quick wins**: Flag anything that's high impact AND quick to fix

Rank by user impact. Quick wins come first.

### Step 3: Create Tickets

Create exactly 5 kanban tickets using `mcp__agentic-kanban__create_issue` (or the CLI) for the most impactful improvements. Each ticket must have:

- **Title**: imperative, specific (e.g. "Add loading state and error feedback to workspace merge button")
- **Description** with clear sections:
  - **## Problem** — what is wrong, with screenshots or specific component/file references
  - **## Proposal** — what to change and why
  - **## Acceptance criteria** — how to verify the fix works
- **Priority**: based on user impact

### Step 4: Report

Output a summary table:

| # | Issue | Impact | Effort | Category |
|---|-------|--------|--------|----------|

Then list the created ticket numbers.

## Rules
- Explore the ACTUAL running UI, not just source code — use playwright-cli to navigate and screenshot
- Every finding must reference a specific screen, component, or interaction, not vague areas
- Focus on real usability pain, not theoretical perfection
- Prioritize by how much the fix improves the user's daily experience
- Do NOT make any code changes — only create tickets describing the improvements