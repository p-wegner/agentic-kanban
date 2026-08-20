# Ideas: Fleet Throughput & Coordination

*2026-07-07 — brainstorm. Theme: with many agents in flight, the bottlenecks are collisions, bad launches, and cold context — not agent capability. The board should schedule like an OS, not like a todo list.*

## What exists today
- Predict Files button (per-ticket, on demand), dependency graph + Analyze Deps, monitor WIP limits + Start Mode, `merge-reconciler` skill (after-the-fact conflict landing), decompose, ticket-enhancer, setup scripts, workflow DAGs, migration-collision folklore in CLAUDE.md.

## Idea 1: File-claim map — conflict *forecasting*, not conflict cleanup
Run Predict Files automatically at launch (and refine it from the live diff as the agent works). Maintain a project-wide claim map: which in-flight workspace touches which paths.

- **Scheduler input**: when the monitor picks the next backlog ticket, prefer ones whose predicted files are unclaimed. Two tickets predicted to collide get *serialized automatically* instead of racing to a rebase fight.
- **Live warning**: card badge "overlaps #84 (session-lifecycle.ts)" the moment diffs start overlapping — today this is discovered at merge time, the most expensive moment.
- **Migration numbers** are the flagship case: a claim on "next drizzle migration slot" would kill a whole recurring failure class.
- The reconciler stays, but as the fallback; forecasting shrinks its caseload.

## Idea 2: Merge train (integration queue)
Ready-to-merge workspaces enter a serial queue: rebase onto current base → fast checks in the worktree → merge → next. One at a time, always against fresh base.

- Kills the "N branches all green against a stale master, stranding each other on merge" pattern that made `merge-reconciler` necessary.
- Pairs with the master canary (see hands-off-verification.md): a train stop that fails checks gets bounced back to its agent with the failure, and the train continues with the next car.
- This is the productized, always-on version of what the Conductor does ad hoc each cycle.

## Idea 3: Launchability gate — don't burn a run on a bad ticket
Score a ticket before auto-start: has acceptance criteria? unambiguous scope? predicted files exist? dependencies resolved? not overlapping a hot claim?

- Below threshold → auto-run ticket-enhancer first, or file an `ask_user` question (see attention-queue.md), *then* launch. Never silently start a doomed run.
- Rationale: the most expensive failure mode isn't a wrong diff — it's a full agent run spent discovering the ticket was ambiguous. The enhancer exists; nothing forces it into the auto-start path.

## Idea 4: Context packs — warm starts from board memory
At launch, auto-assemble a small context file into the worktree: related tickets that touched the predicted files (with outcomes: "#84 failed review here twice for lock handling"), the relevant flight-recorder excerpts, clarification answers from `ask_user`, matching friction-ledger warnings ("this repo: never `rebase --no-edit`").

- The board is the only actor that has seen *all* sessions; today each agent starts amnesiac and re-learns repo landmines transcript by transcript. This is the retrieval half of the compounding loop (the skills/hooks half exists).

## Idea 5: Tournament mode for hard tickets
For tickets tagged `hard` (or after 2 failed attempts): launch N parallel workspaces on the same ticket with different providers/strategies (worktrees make this nearly free), auto-review all, surface a comparison (quality score, evidence, diff size) and merge the winner — auto or via one Needs-You card.

- Turns provider diversity (already integrated: Claude/Codex/Copilot/Pi) from a settings choice into a strategy. Also generates the best provider-scorecard data for free.

## Idea 6: Post-merge dependency cascade with context handoff
The cascade (auto-start unblocked dependents) exists. Add the handoff: the dependent's launch prompt includes the parent's outcome summary ("#84 merged; the new `SessionExitStats` API you depend on looks like X, see files Y"). Chained tickets currently re-discover their parent's work from git archaeology.

## Priority
Ideas 1+2 together attack the dominant throughput killer (merge-time collisions). Idea 3 is cheap and immediately reduces wasted runs. Idea 4 is the sleeper — it compounds forever.
