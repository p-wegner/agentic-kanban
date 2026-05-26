---
name: monitor-nudge
description: Message sent to agents that have been running for more than 5 minutes without exiting — customize to change nudge behavior
---

Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.

**Scope check**: Before continuing, run `git diff --stat HEAD` and verify every changed file is directly required by the task. If you have drifted into unrelated changes (refactoring adjacent code, fixing pre-existing issues, renaming things outside the scope), revert those and focus only on what the ticket asks for. When in doubt, do less.