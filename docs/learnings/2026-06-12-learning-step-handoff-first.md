# Learning Step Must Be Handoff-First

## What happened

On 2026-06-12, a Space Invaders ticket handoff asked for `/learning-step` after the implementation was already complete:

- Issue: #7 Mystery UFO saucer
- Last feature commit: `bfb6f83 Implement mystery UFO saucer`
- Feature files: `src/ufo.js`, `test/smoke.test.js`
- Verification: `npm test` passed
- Handoff said the working tree was clean and merge-ready

When the learning step started, the path `C:\andrena\.worktrees\feature_ak-7-mystery-ufo-saucer` existed but was empty and no longer a Git repo. That is not a failed feature session; it is a post-completion learning request running after board cleanup.

## Lessons

- For inline `/learning-step` calls, trust the structured handoff before probing the worktree.
- An empty or missing feature worktree after a clean handoff means the board may already have cleaned up the workspace. It should trigger transcript/handoff fallback, not implementation recovery.
- Durable evidence for this class of learning is the handoff itself plus commit hashes, changed-file lists, and test results. Re-reading the feature repo is optional, not required.

## Follow-up

- Updated `.claude/skills/learning-step/SKILL.md` so future learning-step runs use handoff-first evidence when no explicit issue/session argument is provided.
