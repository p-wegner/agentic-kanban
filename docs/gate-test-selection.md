# What the pre-merge gate actually selects, per package

Measured 2026-08-23 for **#762** ("77% of changes come back as a fix within a fortnight...
`shared` and `mcp-server` are at 98%"). Candidate 1 of that ticket asks the question this page
answers: *`pnpm test:mine` selects suites by touched files — check whether a `shared` change
selects anything.*

Short answer: **it does, and usually far too much rather than too little.** Candidate 1 as
stated is refuted. There is one real hole, it is narrow, it is not `shared`-specific, and it is
fixed below.

## How the numbers were obtained

`scripts/test-mine.mjs` file-scopes a package with `vitest related <changed files>`, which
selects every suite whose *transformed* module graph reaches a changed file. The counts below
are that same selection, taken from vitest's own node API
(`globTestSpecifications` + `getTestDependencies`, the two calls `related` is built from) rather
than by running suites. Spot-checked against the real CLI: `vitest related
packages/shared/src/types/api.ts` in `packages/shared` prints `No test files found, exiting with
code 0`, matching the 0 below.

## Selected suites for a one-file change, as of 2026-08-23

| Changed file | Selects, in its own package | Selects, in `server` |
|---|---|---|
| `packages/shared/src/lib/git-service.ts` | 9 | **428** |
| `packages/shared/src/lib/changed-packages.ts` | 1 | not measured |
| `packages/shared/src/lib/settings-registry.ts` | 1 | not measured |
| `packages/shared/src/lib/ticket-context.ts` | **0** | not measured |
| `packages/shared/src/types/api.ts` | **0** | **0** |
| `packages/server/src/services/preference.service.ts` | 163 | — |
| `packages/server/src/routes/issues.ts` | 42 | — |
| `packages/mcp-server/src/board-call.ts` | 8 | — |
| `packages/mcp-server/src/tools/create-issue.ts` | 2 | — |
| `packages/mcp-server/src/tools/list-issues.ts` | 2 | — |
| `packages/mcp-server/src/index.ts` | **0** | — |
| `packages/client/src/components/SettingsPanel.tsx` | 1 | — |
| `packages/client/src/routes/BoardPage.tsx` | **0** | — |
| `packages/client/src/components/CreateWorkspaceForm.tsx` | **0** | — |

Suite-file totals for scale: `shared` 101, `server` 735 spec entries, `mcp-server` 44,
`client` 168.

And what a **`shared`-only diff** costs across the monorepo, per `changed-packages.ts` +
`test-mine.mjs`:

- `shared` — `related` against the changed files; if that selects nothing at all, the whole
  `shared` suite (#643's fallback).
- `server`, `mcp-server` — in scope as downstream dependents; `UPSTREAM_DEPENDENCIES` relates
  them against the *shared* paths, which their vitest aliases resolve. A `git-service.ts` change
  therefore pulls **428 of server's suites**.
- `client` — has **no** `UPSTREAM_DEPENDENCIES` entry, so it owns no changed file, cannot be
  related, and runs its **full** suite.
- Plus every `@gate:always-run` suite in each package.

So the 98% rework of `shared` is not a gate that runs nothing. It is a gate that, for a typical
`shared` change, runs most of the repository.

## The one real hole (fixed in this change)

#643 falls back to the full package suite when a file-scoped run selects **zero** suites. That
check is per RUN. Selection is per FILE.

Measured: a two-file diff of `packages/shared/src/types/api.ts` +
`packages/shared/src/lib/changed-packages.ts` selects exactly **1** suite
(`__tests__/changed-packages.test.ts`). The run is not empty, so no fallback fires, and the gate
reports `passed (tier: file-scoped, 2 changed file(s))` having asserted nothing whatsoever about
`types/api.ts` — which is `59/59` on the rework metric, the worst file in the worst module.

`types/api.ts` is the clean example of *why* a file can select nothing: it is type-only, so it is
erased before the module graph `related` walks exists. No suite can ever import it. The same
shape hits `client` (`BoardPage.tsx` + `SettingsPanel.tsx` selects 1) and `mcp-server`
(`index.ts` + any tool file), so this is not a `shared` finding.

**Fix:** `relatedCoverageByFile` / `uncoveredSourceFiles` in `scripts/test-mine.mjs` apply #643's
own rule per file — any changed *source* file that no suite imports forces the package's full
suite, and the run says which files triggered it. The probe fails open (any error returns `null`
and leaves the old whole-run check as the only one) and can be turned off with
`KANBAN_TEST_NO_COVERAGE_PROBE=1`. Pinned by
`packages/server/src/__tests__/test-mine-scope-derivation.test.mjs`.

Cost, measured: ~17s for `server` when every changed file is covered (it stops walking as soon as
every file is accounted for), ~11s for `shared` and ~72s for `server` in the worst case — which
is the case that then runs the full suite anyway.

## What this means for #762

Candidate 1 is **refuted as an explanation of the 98%**: `shared` and `mcp-server` changes are
over-selected, not under-selected, and the per-file hole above only bites a multi-file diff that
happens to include an unimportable file — far too narrow to produce a 98% rework rate.

The evidence points at **candidate 3** (instrument the loop, not the code). A gate that runs 428
server suites plus the whole client suite for a `shared` change, with a **median 0.5 days** to the
follow-up fix, is not a gate that failed to look — it is work being corrected after the gate, by
its own author, in the same sitting. Candidate 2 (characterization tests for the 100%-rework
list) stays valid as separate, narrower work, with one caveat this measurement adds:
`packages/shared/src/types/api.ts` cannot be characterized by a suite that imports it, because
nothing can. It needs type-level assertions or tests on its consumers.

#762 should stay open with candidates 2 and 3 as the remaining work.
