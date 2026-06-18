# Shared Package — Migration Patterns

## Domain model boundary — deliberate non-goal (do NOT add a third entity layer)
The codebase already has a deliberate **two-layer** model and a clean network boundary:
- **Internal model = Drizzle rows.** Repositories/services type-alias `typeof table.$inferSelect`
  (e.g. `issue.repository.ts`, `workspace.repository.ts`). The ORM type is the internal type.
- **Wire contract = hand-authored DTOs** in `shared/src/types/api.ts`. The server MAPS rows into
  these (e.g. `board-status.ts` builds `BoardStatusResponse`); the client imports ONLY these as
  `import type`, never `$inferSelect` or `drizzle-orm`. So Drizzle never crosses the network.

This is the correct boundary for a solo, local-first, SQLite-pinned app. Do **NOT** introduce a
third "domain entity" layer / repository ports returning mapped entities — it was evaluated and
rejected as pure cost (Drizzle is not going to be swapped; the wire boundary already exists). The
architecture guardrails (`.dependency-cruiser.cjs`, `pnpm lint:arch`) enforce the layering that
matters (routes → services → repositories → db; shared is an acyclic leaf) instead.

## Client-bundle safety (#791)
`shared/src/index.ts → lib/index.ts` is reachable by the **client** bundle. Any module re-exported
there as a VALUE that imports a Node builtin (`node:child_process`, `fs`, …) white-screens the whole
UI (Vite externalizes node builtins and throws at load; server stays fine). Re-export node-only
modules as `export type *` and import the runtime value via its deep path server-side. This is now
enforced by `packages/shared/__tests__/barrel-client-safety.test.ts`, not just convention.

## Migration journal required
Every new `packages/shared/drizzle/NNNN_name.sql` file needs a matching entry in `packages/shared/drizzle/meta/_journal.json`. Without it, `drizzle-kit migrate` silently skips the file. See `.llm/workflows.md` for diagnosis workflow.

## Migration statement-breakpoint
Multi-statement SQL files require `--> statement-breakpoint` between each statement. Without it drizzle-kit only executes the first. Always check existing multi-statement migrations for the marker.

## Migration journal timestamps must be monotonic
Drizzle orders migrations by `when` in `_journal.json`. A later migration with an earlier timestamp gets run first — `ALTER TABLE` fails silently because the table doesn't exist yet. Always use timestamps later than the previous entry.

## Migration test list
The `MIGRATION_FILES` export in `packages/server/src/__tests__/helpers/migrations.ts` is now computed dynamically from `packages/shared/drizzle/meta/_journal.json` — no manual maintenance needed. Just ensure every new migration has a journal entry (see "Migration journal required" above) and the test helpers will pick it up automatically.
