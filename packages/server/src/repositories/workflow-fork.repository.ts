/**
 * Facade barrel for the fork-workflow repository (#722).
 *
 * This file used to hold all 34 accessors the fork engine needs. It was grandfathered in
 * the god-module gate's `COHESION_BASELINE` at 33 top-level declarations; the #996-#1003
 * fork/workflow work added a 34th, which breaks the baseline's shrink-only rule and fails
 * `pnpm check:arch` (a merge-blocking gate). Rather than raise the number, the accessors
 * were split by RESPONSIBILITY into five cohesive modules and this file became a
 * re-export-only barrel, so no caller had to change:
 *
 * | module | what it owns |
 * |---|---|
 * | `workflow-fork-children.repository.ts`       | fork-CHILD row lifecycle: queue/launch/fail/delete + the roster reads that cap concurrency (`workspaces` only) |
 * | `workflow-fork-join.repository.ts`           | how a fork ENDS: join/cancel status flips, node-divergence context, consolidate parent/issue/children |
 * | `workflow-fork-session-reads.repository.ts`  | the only cross-aggregate reads into `sessions`/`session_messages` — kept in ONE file so the table-ownership ratchet keeps ONE entry |
 * | `workflow-fork-phase.repository.ts`          | spec-driven PHASE-node launch state on an existing workspace |
 * | `workflow-fork-launch-context.repository.ts` | read-only context assembled BEFORE a child exists: prefs, node skill, parent, issue, project repo path |
 *
 * Same pattern as `session.repository.ts` (#45) and `workspace.repository.ts` (#913):
 * decompose behind a facade barrel, then drop the baseline entry. Add a new accessor to
 * the module that owns its responsibility, never to this file — a declaration here would
 * start the re-accumulation this split undid.
 */
export * from "./workflow-fork-children.repository.js";
export * from "./workflow-fork-join.repository.js";
export * from "./workflow-fork-session-reads.repository.js";
export * from "./workflow-fork-phase.repository.js";
export * from "./workflow-fork-launch-context.repository.js";
