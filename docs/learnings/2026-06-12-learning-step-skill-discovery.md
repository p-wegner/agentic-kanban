# Learning Step Needs Skill Discovery Fallback

## What happened

On 2026-06-12, a Space Invaders learning-step session started from a feature worktree path after the branch had already been merged:

- Issue: #5 Bullets: player shot + invader bombs
- Last feature commit: `845788f Implement projectile system`
- Merge commit observed on the project repo: `842f934 Merge branch 'feature/ak-5-bullets-player-shot-invader-bombs'`
- Handoff said `npm test` passed and the feature worktree was clean

The target project did not expose `learning-step` in the active skill list. The agent first fell back to `distill-learnings`, then manually searched `C:\andrena\agentic-kanban` and found the canonical project-local skill at `.claude/skills/learning-step/SKILL.md`.

## Lessons

- A board-launched slash command must be self-contained when it runs inside arbitrary project worktrees. Project-specific skills from the board repo are not guaranteed to be discoverable in the target repo.
- The learning-step prompt should include a canonical fallback path to the board skill, so the agent can recover without treating the missing slash command as user ambiguity.
- This is distinct from the handoff-first rule: the handoff can be sufficient evidence, but the agent still needs the correct learning-step procedure.

## Follow-up

- Updated the learning-step prompt builders in `packages/server/src/services/merge-helpers.service.ts`, `packages/server/src/startup/merge-workflow.ts`, and `packages/server/src/startup/exit-workflow.ts` to include the canonical skill fallback path.
