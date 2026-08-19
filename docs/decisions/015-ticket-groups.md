# 015 — Ticket groups: one workspace serves N coupled tickets

Status: accepted (2026-08-19) · Ticket: #661 · Related: #492 (merge trains), #918 (auto-contract), decision 010 (decompose/contract symmetry)

## Problem

Adjacent granular tickets each cost a full worktree, agent session, review, and a
~42-minute pre-merge gate run (#492 measured the gate). The backlog accumulates whole
FAMILIES of such tickets (a refactoring-scout run emits 10–20 per session, several
literally saying "do together with #X" in prose), and the quality gate then dominates
wall-clock: implementing three coupled 20-minute tickets costs three 42-minute gates.
The `direct-master` skill already codifies the manual workaround — group tickets so
the gates run once per group — but only OUTSIDE the board's workspace machinery.

## Decision

A **ticket group** is N issues served by ONE workspace. Non-destructive: every ticket
keeps its identity, description, comments, dependencies, and its own Done transition —
in deliberate contrast to `contract_coupled_issues` (#918), which merges bodies and
cancels members.

Structural shape — additive, not a remodel:

- `workspaces.issueId` stays the NOT NULL **lead**. All ~169 existing 1:1 readers
  (branch naming/parsing #146, WIP counting, reconcilers, board projections, teardown
  env) keep operating on the lead unchanged.
- The new `workspace_issue_members` table (migration 0123) lists only the ADDITIONAL
  member issues. FKs cascade both ways; deleting a member merely detaches it.
- "Is this issue being worked?" is now `workspaces.issue_id = X OR X ∈ members` — the
  one NEW blindness the feature introduces, closed centrally by
  `filterIssuesWithLiveGroupWorkspace` in both monitor auto-start loops.

The **grouping signal is the existing `coupled_with` edge** ("touch the same code,
best implemented together"), not a new entity: humans set it in the dependency UI, the
analyzer proposes it, `create_issues_batch` seeds it at birth, and the group-scan pass
writes it in bulk. Consumers now branch on the operator's policy: `auto_contract_coupled`
(destructive collapse, off by default) vs `auto_group_coupled` (group execution, ON by
default, per-project opt-out).

## Mechanics

- **Create**: `POST /api/workspaces` takes `memberIssueIds`. Members are validated
  (same project, no live workspace of their own, not in another live group), flip to
  In Progress in the same transaction as the lead, and are rendered IN FULL into both
  the ticket-context file and the agent prompt, with per-ticket pathspec-commit
  discipline (commit granularity stays per ticket; gate granularity becomes per group —
  the direct-master separation, now board-native). An `autoStart` caller claims every
  member (#366 per member); an unclaimable member is dropped, not fatal.
- **Review + gate**: already workspace-scoped — one review, one gate per group by
  construction. Nothing changed there.
- **Merge**: `finalizeMergeCleanup` fans Done out to members via the idempotent,
  recency-guarded `reconcileMergedIssue` (so a deliberate member reopen is respected);
  the Done writers that bypass it (exit-workflow direct/zero-diff closes, autoMerge,
  monitor direct close) call `reconcileGroupMemberIssues` explicitly. The post-merge
  dependency cascade runs once per completed member.
- **Monitor**: the Todo/Backlog pull expands a passing candidate into its
  `coupled_with` connected component, capped at `MAX_TICKET_GROUP_SIZE` (4), taking
  only members that are themselves independently startable (eligible, untagged,
  uncontended, dependency-unblocked, zero workspace history). One WIP slot per group —
  a group is one agent.
- **Consolidating an existing backlog**: `POST /api/issues/group-scan` / MCP
  `propose_ticket_groups` — one AI pass proposing groups, preview-first; apply writes
  the edges (star topology; the connected component is the group). Guards mirror the
  analyzer's #916 rule: never group across a sequential edge.
- **Prevention**: sizing guidance in `backlog-refill` (gate-sized tickets; fold
  few-minute changes into their neighbours), `refactoring-scout` (declare finding
  families as groups via edges, not prose), and `ticket-enhancer` (couple instead of
  padding).

## Deliberate v1 simplifications

- **Members stay In Progress until Done.** The lead alone moves through In Review; a
  member reads slightly behind during review, but is protected from duplicate starts by
  membership and converges on merge. Fanning In Review out would need the reverse
  transition on every review-fail path for little information gain.
- Group members with ANY workspace history are excluded from auto-grouping (reopen
  semantics are per-issue and unimplemented for groups).
- Plugin-loop unit tickets never join a group (their skill and lifecycle belong to the
  loop).
- The provisioning-crash marker (#630) covers the lead only; a member's protection
  during the provisioning window is the in-process claim.
- Board cards: member issues show the lead's workspace summary (aliased in
  `buildWorkspaceSummaryMap`); there is no dedicated group UI yet.

## Rejected alternatives

- **Join table replacing `workspaces.issueId`** — 169 read sites, most of them
  correctness-critical reconcilers; the lead/member split gets the same behaviour at a
  fraction of the blast radius.
- **Contracting tickets instead (status quo #918)** — destroys per-ticket identity and
  history; operators demonstrably avoid switching it on.
- **Branch names encoding all members** (`feature/ak-105-106-107`) — breaks the strict
  single-number parser whose strictness is load-bearing (#146: a wrong parse
  force-Dones the wrong issue).
