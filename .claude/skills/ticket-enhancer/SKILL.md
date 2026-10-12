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
   - Do not add build-time screenshot, browser automation, Playwright, or browser-install instructions.
3. Use update_issue to save the improved title and/or description
4. Keep the original intent — enhance, don't redesign
5. If visual confirmation is relevant, describe it only as board-owned after-merge verification configured by `visual_verification_mode` / `after_merge_verify_agent`, not as a builder task.
6. Harness classification (#1021): if the ticket is work on the MACHINERY rather than the product — the pre-merge gate, guards, ratchets, always-run markers, the impact map / test selection, typecheck, hooks, the merge path, the monitor cycle — give it the `harness` tag (`update_issue` with `tags: { add: ["harness"] }` — it creates the tag if the board has none yet; the REST fallback is `POST /api/issues/:id/tags` with the tag's id). The monitor budgets how many concurrent builders may run harness tickets (Strategy Bullseye → Harness %), so a missing tag understates that spend and a wrong one costs a deferred cycle. It is a proposal, not a verdict: leave an existing tag alone if a human set it, and never tag a ticket that changes what a USER sees.
7. Sizing check (#661): every ticket costs a full worktree + review + merge-gate run. If this ticket is a few-minutes change that clearly belongs with an adjacent open ticket (same files, same mechanical pattern), do NOT pad it — instead add a `coupled_with` edge to that ticket (add_dependency), so the board implements them together as one ticket group. Never couple across an existing depends_on/blocked_by edge.

Format the description with clear sections:
- What needs to be done
- Why it matters (context)
- Acceptance criteria (if inferable)
- Relevant files or areas (if inferable from the title/context)
- Open Questions (unresolved decisions, assumptions, or clarifications needed before work begins — use `- [ ]` checkboxes)