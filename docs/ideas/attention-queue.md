# Ideas: The Attention Queue — human as exception handler

*2026-07-07 — brainstorm. Theme: hands-off doesn't mean the human is absent; it means the human only sees decisions that genuinely need them, with everything pre-digested for a one-click answer. Today attention is pull-based (scan the board, read the Digest) instead of push-based and triaged.*

## What exists today
- Digest view (what changed while away), blocked filter, OS notifications (session completed / merged), monitor + Conductor that unstick things autonomously, `merge-reconciler` escalating what it can't land.
- But: agents that hit a genuine ambiguity either guess (scope risk) or stall (throughput loss). There is no structured way for an agent to *ask* and keep the pipeline moving.

## Idea 1: "Needs You" queue — a single triage inbox
One view listing only items awaiting a human decision, each with a pre-digested card and one-click actions:

- **Merge escalations** — conflicting cluster the reconciler bounced ("#84 and #91 both rewrote session-lifecycle; pick a base"). Actions: pick winner / open integration worktree / defer.
- **Review stalemates** — workspace failed review N fix-rounds in a row (loop cap). Actions: merge anyway / rewrite ticket / abandon branch.
- **Budget kills / red vitals** the auto-recovery couldn't fix. Actions: relaunch / rebuild branch / close.
- **Agent questions** (Idea 2).
- Ordered by cost-of-delay (how much WIP is blocked behind each item). Badge count in the header; push OS notification only when the queue goes 0→1, not per item — attention is the scarce resource being managed.

The point: the human's entire job in steady state becomes "empty this queue", measured in seconds per item. Everything else is noise the board absorbed.

## Idea 2: `ask_user` MCP tool — structured agent questions, non-blocking
An agent hitting real ambiguity calls `ask_user(question, options[], default, consequence)` and **continues with the default** (or parks that sub-task) instead of stalling:

- Question lands on the issue card + Needs-You queue: "#132: Delete-cascade also removes diff comments? [yes(default)/no]".
- Human answers async → answer injected as a `/turn` into the (possibly still-running or resumable) session; if the agent already proceeded with the default and the human disagrees, the board auto-launches a corrective follow-up turn.
- Answers are **persisted to the ticket** as clarifications, so a relaunch/rebuild doesn't re-ask. Over time tickets accumulate their own FAQ — decisions stop evaporating with sessions.

## Idea 3: Graduated autonomy (trust dial), earned from data
Autonomy today is a global pipeline config (auto-review/auto-fix/auto-merge toggles). Make it a per-ticket-class policy derived from history the Insights DB already holds:

- e.g. *chores + docs*: auto-merge on green evidence, never ask. *features touching `packages/server/src/services/session-manager/*`* (a burned-child hotspot): always require a human glance.
- Policy rows: `(type | tag | path-glob) → {auto_merge | needs_glance | needs_approval}` with a suggested default computed from historical first-review pass rate on matching tickets.
- The board can *propose* loosening: "Last 20 chore merges needed zero human input — auto-merge chores?" Autonomy grows with evidence instead of being a leap of faith.

## Idea 4: Morning briefing = Digest + Needs-You + plan
A scheduled run (feature exists) that composes: what landed overnight, what's in the queue with recommendations ("I'd pick #84's version — #91's is a subset"), and what the monitor plans to start today. Delivered as a Butler message / OS notification. The human's day starts with a 90-second read and 3 clicks, not a board archaeology session.

## Priority
Idea 2 is the keystone — it converts the worst failure mode (silent guessing / stalling on ambiguity) into cheap async QA. Idea 1 is its natural home. Idea 3 is what eventually makes the queue short.
