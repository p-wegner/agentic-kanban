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
sync with `max-file-size.test.ts` (that test stays as the in-IDE signal). Since #982,
`pnpm check:arch` is a composite that ALSO runs `pnpm lint:arch` (the dependency-cruiser
layering rules), so those are merge-blocking via the same CI workflow.

**Cohesion signal counts INTERNAL functions, not just exports (#889).** The cohesion check used
to count only EXPORTED functions/classes, so a god-module hid behind a few exports —
`agent-stream-parser.ts` had 3 exports but 28 internal functions at 1042 lines and waved through.
The signal now counts **top-level function/class declarations + top-level arrow/function-expression
consts, EXPORTED AND INTERNAL** (`> 20` in a `600+`-line file). Top-level only — nested
callbacks belong to their enclosing function; `const` data tables and type/interface exports stay
excluded (cohesive data/contracts). The script's regex fallback (no `typescript` devDep) is anchored
at column 0 so it counts the same top-level shape. A small **ratchet baseline** (`COHESION_BASELINE`
in both files) grandfathers the modules that already exceeded 20 at introduction (session-summary 38,
butler-sdk 30, stack-profile 28, agent.service 27, insights 23, agent-questions 21) at their current
count: the gate blocks any NEW breach and any GROWTH of a baselined file, but a baselined file may
only shrink — decompose it and lower/remove its entry. When a file trips,
decompose it behind a facade barrel — `agent-stream-parser.ts` is the canonical example: the
per-provider parsers live in `src/lib/agent-stream/{claude,codex,copilot,pi}.ts` + shared helpers
in `agent-stream/shared.ts`, all re-exported through the unchanged facade so consumers' imports of
`@agentic-kanban/shared/lib/agent-stream-parser` don't change.

**Third signal: MAX BRANCH COMPLEXITY OF ONE FUNCTION (#726) — because the other two measure
SIZE.** A file split moves lines and top-level declarations for free, so a gate made only of
those two rewards decomposition-for-the-gate. Measured on the tree at #726: the two most
branch-complex functions in the repo were in files that clear the ceiling comfortably
(`agent-stream/copilot.ts`, 341 lines, `parseCopilotEvent` at 41 branches) or park just under it
(`WorkspaceCard.tsx` at 966 lines, 35 branches) — and 13 files sat at 900–999 lines with none
over 1000, i.e. the ceiling had become a floor. `MAX_FUNCTION_BRANCHES = 25` is checked
per FUNCTION, not summed per file: a per-file sum is size again, whereas a single function's
branch count only falls if someone actually restructures it, and relocating a branchy function
lands it on a path with no baseline entry so the flat threshold catches it there.

Counted: `if`, the three `for` forms, `while`/`do`, each non-default `case`, `catch`, `?:`, plus 1
for the function (McCabe). **Not counted: `&&`, `||`, `??`** — measured both ways, and including
them made the metric a proxy for JSX conditional rendering (39 of 253 `.tsx` files over threshold
vs 3 without; `parseCopilotEvent` read 156 instead of 41) and for defensive `?? fallback`
defaulting, which is the idiom that makes code safer. Excluded, it separates 22 files from 1426
instead of smearing 99. Measured distribution: p50 5, p75 9, p90 13, p95 18, p99 28, max 55
(`runAutoStart` in `startup/monitor-auto-start.ts`). `COMPLEXITY_BASELINE` (in BOTH files,
parity-checked) grandfathers those 22 shrink-only; the gate PRINTS entries a file has since
improved past rather than failing them, and a passing run always names the peak and how many
files are baselined — #726 was filed because a green gate said nothing. Rejected as the new
dimension: nesting depth (co-linear with this, and it saturates at 9), fan-in/fan-out (needs the
import graph `lint:arch` already owns; fan-out is lowered by the very facade barrel this gate
recommends, and fan-in depends on a file's importers so an author could not fix their own
failure), and complexity-weighted-by-missing-tests (source→test mapping here is a guess, gamed
by adding a trivial test). Without the `typescript` devDep the complexity signal is SKIPPED and
says so — branches cannot be approximated by regex.

## `lib/` is SEVEN kinds, and only one may touch the DB (#590)

`packages/shared/src/lib` holds 143 files that are not one thing. Placement and the
persistence rule follow from which kind a file is:

| Sub-kind | What it is | May reach `shared/schema` |
|---|---|---|
| **shared-db-op** | a drizzle operation that is the SINGLE write/cascade authority for a domain fact, needed by server AND mcp (`mcp-no-server-internals` forbids mcp importing server code) — `cascade-delete.ts`, `checked-preference-write.ts`, `workflow-engine/status-transition.ts`, `workspace-status.ts`, `issue-number.ts`, `fk-actions.ts`, … | **yes — only this kind** |
| **node-adapter** | one external system behind `xExec`/`xAvailable` or an fs port; deep-path import only, never a value export in the client barrel | no |
| **key-derivation** | pure functions that mint an id/key from parts (`plugin-keys.ts`, `path-key.ts`) | no |
| **contract-codec** | parse/serialize a wire or file contract (`plugin-manifest.ts`, `service-stack-codec.ts`) | no |
| **stream-parser** | incremental agent-output parsing (`agent-stream/*`) | no |
| **pure-policy / projection** | a decision or a derived view over data passed in (`merge-policy.ts`, `profile-allowlist.ts`, `status-view.ts`) | no |
| **telemetry-singleton** | process-wide counters/metrics | no |

The docs called each db-op an "SSOT" or "single write authority" seven times without ever
naming the KIND, so nothing said that the other six are pure with respect to persistence —
and nothing checked it.

**Where it is enforced.** `docs/pattern-language/pattern-language.json` carries `shared-db-op`
as its own element placed BEFORE `shared-lib` (first match wins), with `shared-lib` no longer
allowed to reach `shared-schema`. Because that engine matches PATHS and not imports, the
element's member list is a hand-written enumeration — so
`packages/shared/__tests__/shared-lib-sub-kinds.test.ts` (`@gate:always-run`) re-derives
membership from the imports (`drizzle-orm` is what makes a module a db-op; the tables alone
do not) and fails when the list and the code disagree. Adding a db-op therefore means adding
it to the spec, which is the point.

**The one standing exception**, frozen in that suite and shrink-only: a pure module may read a
column VOCABULARY (`as const`) from `shared/schema` — `dependency-type-traits.ts` does, and the
`shared-schema` element intent explicitly blesses vocabularies living beside their tables. A
pure module importing a TABLE is always a violation.

### The AUDIENCE rule was the unenforced half — #730 ratchet

The seven kinds above say what a `lib/` module may DO. They never said how many packages must
need it, although #590's premise is that `shared/lib` is for code **more than one package**
needs. Measured at #730: **31 of 108** modules directly under `lib/` have exactly one consuming
package — 28 of them `server` alone — and are not imported by `shared`'s own code either. Each
costs a second package on every commit that touches it and buys nothing.

`shared-lib-single-consumer-ratchet.test.ts` (`@gate:always-run`) freezes those 31 as a
**shrink-only** set: a NEW single-consumer module fails, which is the case where the fix is free
(move it to `packages/<pkg>/src/lib/`, drop its `lib/index.ts` re-export, delete the line). The
existing 31 are deliberately NOT relocated — relocating all of them would collapse 2.3% of
multi-package commits, which does not pay for churn in the package everything imports. Full
measurement and the reasoning: `docs/package-boundaries.md`.

Two traps if you re-derive this by hand. **Consumers import through the
`@agentic-kanban/shared/lib` barrel, not by path** — a path-only scan missed a real external
importer for 18 modules, so attribution has to go through the exported symbol. And **a module
that another `shared` module imports stays in `shared`** whatever its external consumer count
(`exec-result.ts` under `git-exec.ts`); 40 of the 108 are in that position and are exempt.

**`shared`'s low co-change containment (17%) is not a defect and is not what this ratchet is
about.** This package holds the DB schema and the wire contract; a package whose job is to be
the one declaration several packages consume cannot have high containment. Half of all
cross-package commits contain no `shared` file at all. Read `docs/package-boundaries.md` before
acting on a containment number — #730 proposed splitting `shared` by consumer on the strength of
that figure and the proposal was rejected on measurement.

## Exec adapters — `lib/<system>-exec.ts`, one result shape (#591)

An exec adapter wraps exactly ONE external CLI: `<system>Exec(args, opts)` + `<system>Available()`,
centralising `windowsHide`, buffer limits, timeouts and error normalisation so the CLI is a single
replaceable port. Three exist: `git-exec.ts` (the sanctioned git spawn point, see the root
CLAUDE.md), `docker-exec.ts`, `devcontainer-exec.ts`.

All three return the shared **`ExecResult`** (`lib/exec-result.ts`) — do not declare a new
`XExecResult` interface:

```ts
{ stdout: string; stderr: string; code: number | null; error: Error | null }
```

`code: null` means the process produced NO exit code — killed by a signal, or never spawned
(ENOENT/timeout). It is deliberately not `-1`: `-1` is a value a real exit can carry, so the two
adapters that used it made "did this run at all?" a different question per adapter. Read the
convention through `execSucceeded` / `execFailedToRun` / `execErrorMessage` rather than
re-deriving it at each call site; `execErrorMessage` prefers stderr over the wrapper's own
message, which is the order `gitExecOrThrow` already used, and never returns an empty string.

`exec-result.ts` is pure (no `node:` import) and so is a VALUE export from the lib barrel; the
adapters themselves are node-only and stay `export type *` + deep-path imports (#791). Guarded by
`exec-adapter-shape.test.ts`.

## Client-bundle safety (#791)
`shared/src/index.ts → lib/index.ts` is reachable by the **client** bundle. Any module re-exported
there as a VALUE that imports a Node builtin (`node:child_process`, `fs`, …) white-screens the whole
UI (Vite externalizes node builtins and throws at load; server stays fine). Re-export node-only
modules as `export type *` and import the runtime value via its deep path server-side. This is now
enforced by `packages/shared/__tests__/barrel-client-safety.test.ts`, not just convention.

## Where a column's VOCABULARY lives (#608) — client-reachability decides, not the table
Enum/vocabulary constants for a column live in four places today (`as const` beside the
`sqliteTable`; `shared/lib`; `shared/types`; or nowhere — `sessions.status` has no shared
union at all). The obvious rule, "declare it beside its table", is **wrong as an
unconditional rule**, and the reason is #596:

- **`shared/schema/*` value-imports `drizzle-orm`.** Anything declared beside a table is
  therefore unreachable from the client without pulling drizzle and the whole schema into
  the browser bundle. That is not hypothetical — it is exactly the bug #596 fixed, where
  17 client modules deep-imported `lib/workspace-status` for four pure predicates and got
  drizzle with them.

So the rule is conditional on who needs it:

| Who reads the vocabulary | Where it goes |
|---|---|
| Client (or anything client-reachable) | `shared/lib/<domain>.ts`, **pure** — no drizzle, no schema, no node builtins. Re-export from the schema barrel if the server prefers to read it there. |
| Server/persistence only | `as const` beside its `sqliteTable` is fine and is the newer style (`DEPENDENCY_TYPES`, `WORKFLOW_NODE_TYPES`, `DRIVE_STATUSES`). |

`ISSUE_PRIORITIES` (`lib/issue-priority.ts`) and the workspace liveness sets
(`lib/workspace-liveness.ts`) are in `lib/` for exactly this reason — the client renders
both. `TERMINAL_STATUS_NAMES` (`lib/status-view.ts`) likewise.

**Do NOT re-export a `lib/` vocabulary through the schema barrel.** `schema` is the
innermost element, so a `shared-schema → shared-lib` edge inverts the layering — and
`check:arch` does not catch it (#618: it stayed green for hours while exactly that edge
existed; only the pattern-language element rules saw it). A server file that wants a
`lib/`-declared vocabulary imports it from `lib/` directly, the same deep path that
`routes/focus.ts` and the CLI already use.

Guarded by `barrel-client-safety.test.ts`, which since #596 seeds its walk from every
`@agentic-kanban/shared/lib/*` specifier found under `packages/client/src` and fails on
drizzle/schema/node-builtins reachable from any of them.

## Migration journal required
Every new `packages/shared/drizzle/NNNN_name.sql` file needs a matching entry in `packages/shared/drizzle/meta/_journal.json`. Without it, `drizzle-kit migrate` silently skips the file. See `.llm/workflows.md` for diagnosis workflow.

## Schema ↔ migrations drift gate
`packages/server/src/__tests__/migration-schema-drift.test.ts` is the CI gate (arch-review #871): it fails on a duplicate `NNNN` number on disk, an un-journaled (orphan) `.sql` file, a journal entry with no file, AND on schema↔migrations divergence — it applies every journaled migration to a fresh in-memory DB and diffs the resulting table+column set against the Drizzle schema (`getTableConfig`). So a schema column with no migration (or the reverse) breaks the build. NOTE: this fresh-apply test — not the snapshot chain — remains the schema↔migrations guarantee; see "drizzle-kit generate" below for what the snapshot chain does and does not tell you. Don't add an orphaned dup-numbered file (that was the original bug: `0039_direct_workspace_base_commit.sql` shadowed by the journaled `0040_*`).

## drizzle-kit generate (re-baselined at 0132 — #789)
`pnpm --filter @agentic-kanban/shared db:generate` works again. It had been unusable for ~126 migrations: `generate` diffs the schema against the NEWEST `drizzle/meta/NNNN_snapshot.json`, and that chain stopped at `0006_snapshot.json` while the journal grew to 133 entries — so every migration since was hand-written, and the schema and the SQL became two independent hand-maintained descriptions of one database.

**What #789 did.** Regenerated ONE snapshot from the current schema (into an empty out dir, so no DB was read and nothing was written to `kanban.db`), installed it as `meta/0132_snapshot.json` — the newest journal entry — and set its `prevId` to `0006_snapshot.json`'s id so drizzle-kit sees an unforked chain. `generate` then reports "No schema changes"; adding a trivial column to the schema produces exactly `ALTER TABLE ... ADD ...`.

**The 0007..0131 gap is deliberate.** Those snapshots are not reconstructible from anything but the migrations themselves, and fabricating them would be a claim about what each migration did that nobody can check. The committed `.sql` files are the history; the snapshot chain only has to be correct at its HEAD for `generate` to work going forward.

**Verified before re-baselining** (this was the load-bearing step): a DB built from all 133 migrations in a scratch temp file, introspected with `drizzle-kit pull`, agrees with the Drizzle schema on EVERY table and column. The only divergences are objects the schema never declares and the DB has by design — 8 hand-written perf indexes, 2 FKs (`projects.default_skill_id`, `workspaces.showdown_id`), and `issue_dependencies.type`'s SQL `DEFAULT 'depends_on'` (the schema expresses it as `$defaultFn`). Consequence to know about: `generate` is blind to those, so **declaring one of them in the schema later will emit a `CREATE INDEX` / FK rebuild for something that already exists** — check the generated SQL against the live DDL in that case.

**Adding a migration from here on.** Prefer `db:generate` and commit BOTH the `.sql` and the new `meta/NNNN_snapshot.json`. A hand-written migration is still fine (and still necessary for anything drizzle-kit cannot express — data backfills, FK-action rebuilds), but then the snapshot goes stale again: refresh the baseline in the same commit, or `packages/shared/__tests__/drizzle-snapshot-baseline.test.ts` fails. That guard asserts the newest journal entry has a matching snapshot, that no two snapshots share a `prevId` (drizzle-kit refuses to run on a forked chain), and that the newest snapshot's tables/columns still equal the schema's.

## Migration statement-breakpoint
Multi-statement SQL files require `--> statement-breakpoint` between each statement. Without it drizzle-kit only executes the first. Always check existing multi-statement migrations for the marker.

## Migration journal timestamps must be monotonic
Drizzle orders migrations by `when` in `_journal.json`. A later migration with an earlier timestamp gets run first — `ALTER TABLE` fails silently because the table doesn't exist yet. Always use timestamps later than the previous entry.

## Migration test list
The `MIGRATION_FILES` export in `packages/server/src/__tests__/helpers/migrations.ts` is now computed dynamically from `packages/shared/drizzle/meta/_journal.json` — no manual maintenance needed. Just ensure every new migration has a journal entry (see "Migration journal required" above) and the test helpers will pick it up automatically.
