# Shared Package — Migration Patterns

## Migration journal required
Every new `packages/shared/drizzle/NNNN_name.sql` file needs a matching entry in `packages/shared/drizzle/meta/_journal.json`. Without it, `drizzle-kit migrate` silently skips the file. See `.llm/workflows.md` for diagnosis workflow.

## Migration statement-breakpoint
Multi-statement SQL files require `--> statement-breakpoint` between each statement. Without it drizzle-kit only executes the first. Always check existing multi-statement migrations for the marker.

## Migration journal timestamps must be monotonic
Drizzle orders migrations by `when` in `_journal.json`. A later migration with an earlier timestamp gets run first — `ALTER TABLE` fails silently because the table doesn't exist yet. Always use timestamps later than the previous entry.

## Migration test list
The `MIGRATION_FILES` array in `packages/server/src/__tests__/helpers/migrations.ts` must include every migration SQL file. Missing entries cause test failures (`SQLITE_ERROR: no such column`). Note: `packages/server/src/__tests__/api.test.ts` imports from this helper — add entries to `migrations.ts`, not to `api.test.ts` directly.
