---
name: dependency-analyzer
description: Analyze a ticket and its relationships to other open tickets, suggest dependency updates
---

Analyze the given issue and its relationships to other open (non-Done, non-Cancelled) issues on the board.

## Steps

1. **Read the target issue** — use `get_issue` with the current issue's ID to get its full title and description
2. **List all open issues** — use `list_issues` filtered to `statusName="Todo"`, `"In Progress"`, and `"In Review"` (call three times or rely on context)
3. **Analyze relationships** for:
   - Sequential dependencies: does the target issue require another to be finished first?
   - Shared code areas: do both issues touch the same component, route, or service?
   - **Predicted touched-file overlap (coupling signal):** the analyzer feeds in a deterministic signal listing other issues that share AI-predicted touched files (`touched_files_json`) with the target above the configurable `coupling_overlap_threshold`. Treat a high-overlap pair as a strong `coupled_with` candidate — they touch the same code and are best implemented (or contracted) together. These also surface as **advisory** coupling suggestions in the dependency UI; accepting one creates a `coupled_with` edge. Never couple across an existing `depends_on`/`blocked_by` edge (respect direction).
   - Merge conflict risk: are two issues In Progress simultaneously and modifying the same files?
   - Parent/child relationships: is one issue a sub-task or epic of the other?
4. **Add dependency links** using `add_dependency`:
   - `issueId`: the target issue's ID (the one being analyzed)
   - `dependsOnId`: the ID of the related issue
   - `type`: choose from `depends_on`, `blocked_by`, `related_to`, `coupled_with`, `parent_of`, `child_of`
5. **Update the issue description** with a `## Dependencies` section listing each relationship and its rationale

## Dependency type guide

| Type | When to use |
|------|-------------|
| `depends_on` | Target issue cannot start until the other is complete |
| `blocked_by` | Another issue is actively blocking the target |
| `related_to` | Same component/area, merge conflict risk, or thematically paired |
| `coupled_with` | Two issues touch the same code and are best implemented together (peer coupling) — distinct from `depends_on` (sequential) and `related_to` (topical only) |
| `parent_of` | Target is an epic; the other is a sub-task |
| `child_of` | Target is a sub-task of the other issue |

## Rules

- Only add a dependency if there is a **clear technical reason** the issues are coupled — avoid topical similarity alone
- Prefer `related_to` for In Progress issues that touch the same files (coordination risk)
- Prefer `depends_on` when one issue must land in production before the other can be implemented
- Use `coupled_with` for peer issues that touch the same code and should ship together — but never couple two issues that already have a `depends_on` edge (that pairing is sequential by design)
- Skip issues that are already linked (check existing dependencies in `get_issue` output)
- Do not link an issue to itself
