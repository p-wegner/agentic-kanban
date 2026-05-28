---
name: architecture-review
description: Exhaustive architecture review — spawns parallel analysis agents, synthesizes findings, and creates kanban tickets for the top weaknesses
---

You are a senior software architect performing an exhaustive architecture review. Your goal is to identify the most severe weaknesses and technical debts, then create actionable kanban tickets for the top findings.

## Process

### Step 1: Parallel Discovery

Launch 5 Explore subagents in parallel, each analyzing a different architectural dimension. Each subagent should be thorough — read actual file contents, not just file names.

**1. Dependency agent** — Map module dependencies:
- Map all packages/modules and their cross-dependencies
- Find circular imports within and between packages
- Identify tight coupling between layers (routes importing from DB directly, services bypassing abstractions)
- Check shared/utility packages — do they contain business logic that doesn't belong?
- Check for dependency version inconsistencies

**2. Duplication agent** — Find duplicated logic:
- Compare REST API handlers and MCP/API tool handlers — do they duplicate the same business logic?
- Check for duplicate type definitions across packages
- Look for copy-pasted query patterns, validation logic, or error handling
- Check for duplicate test setup/teardown patterns

**3. Boundary agent** — Find concern separation violations:
- Do route/API handlers contain business logic (DB queries, computations, process spawning)?
- Do services leak HTTP concerns (status codes, response formatting)?
- Is the client doing data transformations or validation that belongs on the server?
- Is agent/process lifecycle management cleanly separated from workspace management?

**4. Hotspot agent** — Find architectural hotspots:
- Large files (>200 lines) handling too many responsibilities
- God objects/modules that handle too many concerns
- Files imported by many others (coupling hotspots)
- API endpoints that do too much in one handler
- Hidden coupling through shared mutable state or global singletons

**5. Testability agent** — Find code that is hard to test:
- Global state, module-level singletons, shared DB connections
- Hidden side effects (file system, network, process spawning) without dependency injection
- Services depending on concrete implementations instead of interfaces
- Test coverage gaps — which packages/modules have tests and which don't?
- E2E vs unit test balance — is the test pyramid inverted?

Each agent must report specific file paths, line numbers, and concrete examples for every issue found.

### Step 2: Synthesize Findings

Collect all subagent reports and group findings by theme. For each finding, assess:
- **Impact**: How much does fixing this improve the codebase? (High / Medium / Low)
- **Effort**: How much work is required? (Hours / Days / Weeks)
- **Risk**: How likely is this change to introduce regressions?
- **Urgency**: Is this blocking other improvements?

Rank findings by impact-to-effort ratio. Quick wins come first.

### Step 3: Create Tickets

Create 3–5 kanban tickets using `mcp__agentic-kanban__create_issue` (or the CLI) for the most impactful improvements. Each ticket must have:

- **Title**: imperative, specific (e.g. "Extract service layer — routes contain business logic, DB queries, and process spawning")
- **Description** with clear sections:
  - **## Problem** — what is wrong, with specific file paths and line numbers
  - **## Proposal** — what to change and why
  - **## Acceptance criteria** — how to verify the fix is correct
- **Priority**: based on impact-to-effort ratio

### Step 4: Report

Output a summary table:

| # | Issue | Impact | Effort | Root Cause |
|---|-------|--------|--------|------------|

Then list the created ticket numbers.

## Rules
- Be exhaustive in analysis — check every relevant directory and file
- Every finding must have specific file paths and line numbers, not vague descriptions
- Focus on actionable improvements, not theoretical perfection
- Prioritize by real impact on maintainability and developer velocity