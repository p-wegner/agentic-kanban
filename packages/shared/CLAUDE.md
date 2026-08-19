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
`packages/server/src/__tests__/migration-schema-drift.test.ts` is the CI gate (arch-review #871): it fails on a duplicate `NNNN` number on disk, an un-journaled (orphan) `.sql` file, a journal entry with no file, AND on schema↔migrations divergence — it applies every journaled migration to a fresh in-memory DB and diffs the resulting table+column set against the Drizzle schema (`getTableConfig`). So a schema column with no migration (or the reverse) breaks the build. NOTE: the drizzle snapshot chain (`meta/NNNN_snapshot.json`) was abandoned at 0006, so `drizzle-kit generate --check` is NOT reliable here — this fresh-apply test is the substitute. Don't add an orphaned dup-numbered file (that was the original bug: `0039_direct_workspace_base_commit.sql` shadowed by the journaled `0040_*`).

## Migration statement-breakpoint
Multi-statement SQL files require `--> statement-breakpoint` between each statement. Without it drizzle-kit only executes the first. Always check existing multi-statement migrations for the marker.

## Migration journal timestamps must be monotonic
Drizzle orders migrations by `when` in `_journal.json`. A later migration with an earlier timestamp gets run first — `ALTER TABLE` fails silently because the table doesn't exist yet. Always use timestamps later than the previous entry.

## Migration test list
The `MIGRATION_FILES` export in `packages/server/src/__tests__/helpers/migrations.ts` is now computed dynamically from `packages/shared/drizzle/meta/_journal.json` — no manual maintenance needed. Just ensure every new migration has a journal entry (see "Migration journal required" above) and the test helpers will pick it up automatically.
