---
name: dependency-analyzer
description: Analyze a ticket and its relationships to other open tickets, suggest dependency updates
---

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

Focus on actionable dependencies, not just topical similarity. Only add a dependency if there is a clear technical reason the issues are coupled.