# Merge trains: the train shepherd

Each merge train gets ONE persistent agent, the **train shepherd** (not the Steward, which is the
Monitor Butler). It owns making the train mergeable: it resolves member-vs-member conflicts and
fixes a red train gate, reusing one session so its context already holds the member tickets.

## What shipped (#1569, phase 1)
- **Brief** (`buildAgentFixBrief`, `merge-train-agent-fix.ts`): the first turn carries, per member,
  issue number, title, trimmed description/acceptance criteria, branch and changed files. Later
  turns add only the new member(s) or the new failure.
- **Session reuse** (`merge-train-shepherd.ts`): `TrainShepherd` keeps the session id across turns
  (`resumeSessionId`); `mergeMembersWithShepherd` hands each member conflict to it.
- **Infrastructure failure is not a verdict**: a worker disconnect, launch failure or zero-token
  session re-places the turn and consumes no turn, up to `SHEPHERD_MAX_INFRA_RETRIES`; then the
  attempt is `agent_fix_held` (inconclusive), not red.
- **Red with no owner**: feedback goes only to members that own the failing files
  (`merge-train-red-feedback.ts`); if none does, no builder is messaged.
- **Caps**: the existing `merge_train_agent_fix_*` prefs bound the shepherd as a whole.

## Not shipped yet (follow-up #1572)
Incremental assembly (worktree at window open, merge per member, conflicts to the shepherd instead
of deferral); one shared runner for conflicts and red gates; a placed-session runner reporting
usage so the cost cap bites; the held outcome in `merge-queue-train.ts` plus one attention line;
the shepherd line in `status --watch`. Deferral to the next train stays the fallback when the
shepherd cannot resolve, logged with the reason.
