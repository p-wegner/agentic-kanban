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

## God-module gate — the gate of record is a script, not just a test (#888)
The cohesion-aware god-module guard (>1000-line hard ceiling + low-cohesion export-breadth
signal, #875) had two parts that drifted: `packages/shared/__tests__/max-file-size.test.ts`
asserted it, but it lived only in `test:mine` and a 1042-line `agent-stream-parser.ts` merged
past it (the gate was decorative). The **merge-blocking gate of record is now
`scripts/check-god-modules.mjs`** — a dependency-light Node script (works with OR without the
`typescript` devDep, falling back to a regex heuristic for the cohesion count) that exits
non-zero on any breach. It is wired into `pnpm check:arch` (and thus `pnpm check` / `check:full`)
and into CI (`.github/workflows/arch-gate.yml`, runs on PRs to master). Keep its thresholds in
sync with `max-file-size.test.ts` (that test stays as the in-IDE signal). When a file trips,
decompose it behind a facade barrel — `agent-stream-parser.ts` is the canonical example: the
per-provider parsers live in `src/lib/agent-stream/{claude,codex,copilot,pi}.ts` + shared helpers
in `agent-stream/shared.ts`, all re-exported through the unchanged facade so consumers' imports of
`@agentic-kanban/shared/lib/agent-stream-parser` don't change.

## Client-bundle safety (#791)
`shared/src/index.ts → lib/index.ts` is reachable by the **client** bundle. Any module re-exported
there as a VALUE that imports a Node builtin (`node:child_process`, `fs`, …) white-screens the whole
UI (Vite externalizes node builtins and throws at load; server stays fine). Re-export node-only
modules as `export type *` and import the runtime value via its deep path server-side. This is now
enforced by `packages/shared/__tests__/barrel-client-safety.test.ts`, not just convention.

## Migration journal required
Every new `packages/shared/drizzle/NNNN_name.sql` file needs a matching entry in `packages/shared/drizzle/meta/_journal.json`. Without it, `drizzle-kit migrate` silently skips the file. See `.llm/workflows.md` for diagnosis workflow.

## Schema ↔ migrations drift gate
`packages/server/src/__tests__/migration-schema-drift.test.ts` is the CI gate (arch-review #871): it fails on a duplicate `NNNN` number on disk, an un-journaled (orphan) `.sql` file, a journal entry with no file, AND on schema↔migrations divergence — it applies every journaled migration to a fresh in-memory DB and diffs the resulting table+column set against the Drizzle schema (`getTableConfig`). So a schema column with no migration (or the reverse) breaks the build. NOTE: the drizzle snapshot chain (`meta/NNNN_snapshot.json`) was abandoned at 0006, so `drizzle-kit generate --check` is NOT reliable here — this fresh-apply test is the substitute. Don't add an orphaned dup-numbered file (that was the original bug: `0039_direct_workspace_base_commit.sql` shadowed by the journaled `0040_*`).

## Migration statement-breakpoint
Multi-statement SQL files require `--> statement-breakpoint` between each statement. Without it drizzle-kit only executes the first. Always check existing multi-statement migrations for the marker.

## Migration journal timestamps must be monotonic
Drizzle orders migrations by `when` in `_journal.json`. A later migration with an earlier timestamp gets run first — `ALTER TABLE` fails silently because the table doesn't exist yet. Always use timestamps later than the previous entry.

## Migration test list
The `MIGRATION_FILES` export in `packages/server/src/__tests__/helpers/migrations.ts` is now computed dynamically from `packages/shared/drizzle/meta/_journal.json` — no manual maintenance needed. Just ensure every new migration has a journal entry (see "Migration journal required" above) and the test helpers will pick it up automatically.
