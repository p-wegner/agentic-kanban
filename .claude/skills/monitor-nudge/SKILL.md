---
name: monitor-nudge
description: Message sent to agents that have been running for more than 5 minutes without exiting — customize to change nudge behavior
---

Please continue with the task. If you are waiting for input or unsure how to proceed, use your best judgment and keep moving forward. Check the issue description and any open questions, then take the next logical step.

**Commit checkpoint:** if `tsc -b --noEmit` already passes for the packages you touched and the directly-related tests pass, but you have NOT committed yet, **commit now** before doing anything else. Don't keep polishing on top of uncommitted green work — this nudge means you've been running a while, and an interruption would lose everything since your last commit. Push the polish into a follow-up commit.