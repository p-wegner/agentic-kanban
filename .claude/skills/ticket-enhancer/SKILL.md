---
name: ticket-enhancer
description: Enhance a ticket's title and description for clarity and completeness
---

Review and enhance the given issue to make it more actionable for an AI agent.

Steps:
1. Use get_issue to read the current title and description
2. Analyze for clarity, completeness, and actionability:
   - Is the title descriptive enough? Rewrite if vague.
   - Does the description include: what to implement, acceptance criteria, relevant files/areas?
   - Are there implicit requirements that should be made explicit?
3. Use update_issue to save the improved title and/or description
4. Keep the original intent — enhance, don't redesign

Format the description with clear sections:
- What needs to be done
- Why it matters (context)
- Acceptance criteria (if inferable)
- Relevant files or areas (if inferable from the title/context)
- Open Questions (unresolved decisions, assumptions, or clarifications needed before work begins — use `- [ ]` checkboxes)