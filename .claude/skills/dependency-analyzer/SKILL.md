---
name: dependency-analyzer
description: Analyze a ticket and its relationships to other open tickets, suggest dependency updates
---

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> 741e4c0 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> a38c748 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> c24a7ee (feat: implement dependency-analyzer skill with improved prompt)
Analyze the given issue and its relationship to other open (non-Done, non-Cancelled) issues on the board.

Steps:
1. Use get_issue to read the full details of the target issue
2. Use list_issues to get all open issues (filter out Done and Cancelled)
3. Analyze the titles and descriptions for:
   - Shared code areas or files
   - Sequential dependencies (X must be done before Y)
   - Related functionality that could conflict
4. Use add_dependency to create any discovered "depends on" relationships
5. Use update_issue to add a "## Dependencies" section to the issue description listing discovered relationships

<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.
=======
=======
>>>>>>> b63e4a8 (feat: implement dependency-analyzer skill with improved prompt)
=======
Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.
=======
>>>>>>> c24a7ee (feat: implement dependency-analyzer skill with improved prompt)
Analyze the given issue and its relationships to other open (non-Done, non-Cancelled) issues on the board.

## Steps

1. **Read the target issue** — use `get_issue` with the current issue's ID to get its full title and description
2. **List all open issues** — use `list_issues` filtered to `statusName="Todo"`, `"In Progress"`, and `"In Review"` (call three times or rely on context)
3. **Analyze relationships** for:
   - Sequential dependencies: does the target issue require another to be finished first?
   - Shared code areas: do both issues touch the same component, route, or service?
   - Merge conflict risk: are two issues In Progress simultaneously and modifying the same files?
   - Parent/child relationships: is one issue a sub-task or epic of the other?
4. **Add dependency links** using `add_dependency`:
   - `issueId`: the target issue's ID (the one being analyzed)
   - `dependsOnId`: the ID of the related issue
   - `type`: choose from `depends_on`, `blocked_by`, `related_to`, `parent_of`, `child_of`
5. **Update the issue description** with a `## Dependencies` section listing each relationship and its rationale

## Dependency type guide

| Type | When to use |
|------|-------------|
| `depends_on` | Target issue cannot start until the other is complete |
| `blocked_by` | Another issue is actively blocking the target |
| `related_to` | Same component/area, merge conflict risk, or thematically paired |
| `parent_of` | Target is an epic; the other is a sub-task |
| `child_of` | Target is a sub-task of the other issue |

## Rules

- Only add a dependency if there is a **clear technical reason** the issues are coupled — avoid topical similarity alone
- Prefer `related_to` for In Progress issues that touch the same files (coordination risk)
- Prefer `depends_on` when one issue must land in production before the other can be implemented
- Skip issues that are already linked (check existing dependencies in `get_issue` output)
- Do not link an issue to itself
<<<<<<< HEAD
<<<<<<< HEAD
>>>>>>> 66f1d46 (feat: implement dependency-analyzer skill with improved prompt)
=======
>>>>>>> b63e4a8 (feat: implement dependency-analyzer skill with improved prompt)
=======
Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.
>>>>>>> 741e4c0 (chore: add exported agent skills to .claude/skills/)
=======
Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.
>>>>>>> abd2196 (chore: add exported agent skills to .claude/skills/)
=======
Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.
>>>>>>> a38c748 (chore: add exported agent skills to .claude/skills/)
=======
>>>>>>> 66f1d46 (feat: implement dependency-analyzer skill with improved prompt)
>>>>>>> c24a7ee (feat: implement dependency-analyzer skill with improved prompt)
