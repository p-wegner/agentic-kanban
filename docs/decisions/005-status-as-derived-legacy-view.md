# 005. Status as Derived Legacy View

Date: 2026-05-31

## Decision

Keep `issues.statusId` as a permanent compatibility and display view for now. Workflow-driven issues use `issues.currentNodeId` joined to `workflow_nodes.nodeType` as the behavioral source of truth; the status column is synchronized from that workflow state and remains useful for non-workflow/legacy issues, board column display, and older MCP/API consumers.

## Consequences

- Business logic that decides whether an issue is terminal/open/resolved must prefer `currentNodeId` + `nodeType` when `currentNodeId` is present.
- Legacy/non-workflow issues continue to use status names such as `Done` and `Cancelled`.
- UI display and filtering by visible status column can keep reading `project_statuses.name`; removing `statusId` would require a separate migration and API compatibility plan.
