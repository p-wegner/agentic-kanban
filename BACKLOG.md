---
kanban-md: 1
project: agentic-kanban
exported: 2026-08-24T01:48:12.142Z
statuses: Backlog, Todo, In Progress, In Review, AI Reviewed
filter: status=open
issues: 7
---

# agentic-kanban — backlog

<!-- Backlog Markdown (kanban-md 1). One `##` per status column, one `###` per issue; the backtick line under a heading is its metadata. Edit freely and re-import — issues match by #number, then by title. Spec: docs/backlog-markdown.md -->

## Backlog

### #841 Worker agents: detach POSIX-only so stop() actually reaches the shell's process group (#836 remainder)
`priority: medium` · `type: task` · `created: 2026-08-24` · `updated: 2026-08-24`

Follow-up to #836 (which is itself the worker-side follow-up to #833/#828).

#836 moved `worker-agent-runner.stop()` off its private `process.platform` branch and onto
`killProcessTree(pid, { timeout: 5000, signal: "SIGTERM", group: true })`. That made the stop
path assertable on either platform (mocked seam), but it did NOT change reach on POSIX:
`assign` spawns WITHOUT `detached: true`, so the child leads no process group, `-pid` is
ESRCH, and the seam falls back to the bare pid — exactly the pre-#833 behaviour.

So the residual #833-shape gap is still open for the worker: on POSIX with `useShell`, the
child is `sh -c "<command>"`. `sh` execs through for a single simple command, but a pipeline,
an `&&`, or a trailing redirect leaves it a real parent — the shell dies, the agent keeps
running, and the board records the session as stopped.

#### What remains

Add `detached: true` to the `assign` spawn, **POSIX-only**, and verify it on Linux.

#### Why #836 did not do it

- **Measured on the board's Windows box**: `detached: true` + `shell: true` on win32 HANGS —
  the child never reaches its `exit` and its piped stdout never closes. (4-cell probe over
  detached x shell; the other three cells stream and exit normally.) This is the same
  combination `shouldDetachAgent` already refuses on the host. On THIS module it is the
  common Windows path, because `resolveSpecCommand` returns `useShell: true` for every
  `.cmd`/`.bat`/`.ps1` shim. So a blanket detach would break Windows workers outright.
- A POSIX-gated detach cannot be exercised at all on a Windows box, and it contradicts the
  runner's stated invariant ("the daemon owns its children for their whole life"): there is
  no pid persistence and no reattach here, unlike `agent.service`.
- Exposure is narrow: `resolveSpecCommand` returns `useShell: false` for every
  intent-carrying spec on POSIX, so the shell only appears for a same-filesystem
  (`--shares-filesystem`) or legacy-board spec that sent `useShell` verbatim.

#### Acceptance

- `detached: true` in `worker-agent-runner.assign`, gated to `process.platform !== "win32"`
  (and arguably to `launch.useShell`, which is the only case that needs it).
- Evidence from an actual Linux run that (a) stdout/stderr still stream and the child still
  exits, and (b) stopping a `sh -c "a | b"` agent kills the agent, not just the shell.
  #834 is the Linux CI run this would ride on.
- Decide what the daemon owes a detached child on shutdown — `stopAll()` reaches it via the
  group kill, but a `SIGKILL`ed daemon now leaves a session leader nothing can reap.
- `packages/server/src/__tests__/worker-stop-kill-seam.test.ts` already pins the CURRENT
  (fallback) semantics in its third describe; that describe is what must be updated when the
  reach actually changes.

## Todo

### #807 coverage follow-up (797): decide the CI placement and whether a floor becomes a gate — plus one unexplained no-report run
`priority: medium` · `type: task` · `created: 2026-08-23` · `updated: 2026-08-23`

#797 landed the measurement: all four packages now emit coverage (`reportOnFailure: true` was the root cause — a run with ANY failing test wrote no report at all, and this repo's tree-scanning guard suites are red whenever a neighbour has uncommitted work in the shared checkout, which is what burned #765's 20m49s server run). `pnpm coverage:merge` re-anchors package-relative `SF:` paths to the repo root so the analyzer can take one merged lcov, and the arch-gate job uploads it.

**Baseline as measured (loaded dev box, ~28m30s total):** repo-wide 71.87% lines (33454/46550), 61.34% branch, 63.47% functions across 1,135 files. shared 76.37% / server 79.14% / mcp-server 48.85% / client 48.98%.

#### What is NOT decided — this ticket's job

1. **Does the `coverage` job move onto `pull_request`?** There is now a baseline but no CI timing, and 28 minutes on a loaded dev box says nothing about a CI runner. Measure it there first.
2. **Does `--min <pct>` become a floor?** If yes: at what number, per-package or repo-wide, and what happens to mcp-server and client at ~49%. A floor set above where a package sits today is a gate that is red on arrival; a floor set at today's number ratchets nothing unless it is raised.

#### The loose thread, recorded rather than chased

The FIRST full server run (26m29s, 12 failing files) produced **no report despite `reportOnFailure: true`** — vitest printed its summary then exited without the coverage phase or the globalSetup teardown. The identical re-run worked, as did a deliberate single-file failing probe. Unexplained. If the CI job ever comes back green-with-no-artifact, this is the thing to suspect. Re-run before concluding anything from a missing report.

#### Useful side finding from the same run

The ten files #726/#728/#700 name as refactor targets are all >=65% lines (median 84%, eight above repo-wide) — so #765's "cover it before refactoring" precondition does not bind for them. Weakest are `workspace-services.service.ts` (65.25% lines but **48.97% functions**) and `exit-workflow.ts` (70.47% lines, **56.46% branches**).

### #808 Shrink the #788 grandfathered set: 1044 type errors across 132 server test files
`priority: medium` · `type: task` · `created: 2026-08-23` · `updated: 2026-08-23`

Follow-up to #788, filed under the partial-refactor disclosure rule (#691).

#788 closed the structural hole: `packages/server/tsconfig.json` no longer excludes `src/__tests__` wholesale, so `pnpm typecheck` now typechecks ~578 server test files that it never looked at before. What it could NOT do in one pass is fix the errors that were hiding there.

#### Measured baseline (2026-08-23)

With tests fully included and nothing excluded: **1047 `error TS…` lines across 133 server test files, and ZERO in production code.** One of those files (`src/__tests__/helpers/rm-or-report-holder.ts`, 3 errors) was fixed on the spot because a non-grandfathered test imports it, so the remainder is **1044 errors across 132 files**, listed by name in `packages/server/tsconfig.json`'s `exclude` array.

By error code:

| Code | Count | What it is |
|---|---|---|
| TS18046 | 309 | `'x' is of type 'unknown'` — mostly `await res.json()` never narrowed |
| TS2352 | 292 | `as X` cast between insufficiently-overlapping types |
| TS2345 | 130 | argument type mismatch |
| TS2339 | 58 | property does not exist |
| TS18048/18047 | 55 | possibly undefined/null |
| TS2769 | 39 | no overload matches |
| TS2322 | 37 | assignment type mismatch |
| others | ~126 | TS2571, TS2493, TS2556, TS2741, TS2739, TS7006, TS7016, … |

Distribution is long-tailed: 40 files have exactly 1 error, 22 have 2, 14 have 3, 14 have 4 — so **62 of the 132 files have ≤2 errors**. Four files dominate the count: `monitor-auto-start.test.ts` (210), `session-summary.test.ts` (86), `monitor-auto-start-already-merged.test.ts` (53), `issues-routes-edge-cases.test.ts` (50).

#### Why this is worth doing rather than leaving grandfathered

Several of the single-error files are exactly the bug class #788 exists to catch — a production signature moved and the test fixture was never updated:

- `reconciler.service.test.ts` — its `MergeQueuePlan` fixture is missing `clusters`, `recommendedStrategy`, `strategyReason`.
- `resolver-provider-relaunch.test.ts` — `ProviderProfilePolicy` fixture missing `notes`.
- `gate-recommendation-skip-trace.test.ts` — `PluginLoopGate` fixture missing `resolve`.
- `plan-mode-exit-harness.test.ts` — passes `"claude-code"` where the type is `ProviderId`.
- `remote-session-survives-board-restart.test.ts` — reaches for `trackedSessionIds`, which `AgentExecutionService` does not have.

Each of those is a test asserting against a shape the code no longer has.

#### Shape of the work

Batch it by error class, cheapest first — this is meant to be several small commits, not one:

1. **The ≤2-error tail (62 files).** Mostly one-line fixture or cast fixes. Biggest ratchet movement per unit of effort.
2. **TS7016 (3 files)** — `scripts/*.mjs` imported from tests with no types. Either add a `.d.ts` beside the script or a narrow `@ts-expect-error` with a reason.
3. **TS18046 (309)** — the `await res.json()` family. A typed test helper (`readJson<T>(res)`) fixes most of them in one place rather than 309 casts.
4. **The four big files** last.

Rules from #788, unchanged: never `// @ts-nocheck` a file, never loosen `strict`, never change what a test asserts. `@ts-expect-error` is allowed only with a comment saying why (e.g. a test deliberately passing a wrong shape to assert a runtime guard).

#### Done means

Each batch deletes its files from `packages/server/tsconfig.json`'s `exclude` and lowers `BASELINE_GRANDFATHERED_FILES` in `packages/server/src/__tests__/server-test-typecheck-ratchet.test.ts` to match. That ratchet already enforces both halves — the list may only shrink, and an entry whose file typechecks clean fails as stale — so a batch that forgets to update it goes red. The ticket is Done when the exclude array is empty and the ratchet can be deleted.

### #831 #819 remainder: 90 split-responsibility candidates, and the re-derive command returns zero because the cached analysis is too shallow
`priority: medium` · `type: chore` · `created: 2026-08-23` · `updated: 2026-08-23`

**Split off from #819**, which closed on the five candidates #728 named by hand. This carries the rest, plus the reason the obvious first step does not currently work.

#### The blocking finding - read this before doing anything else

#819 tells you to re-derive the list with:

```
code-metrics refactor code-metrics-out/analysis.json --move split_responsibility
```

Against the analysis currently on disk that returns **72 moves, of which ZERO are `split_responsibility`** (53 `introduce_event`, 17 `relocate_file`, 1 each `introduce_facade` / `extract_shared`). The string does not occur in `analysis.json` at all.

**Cause, diagnosed rather than guessed:** that cached run (2026-08-23 12:30) has `function_count: 0`, `functions: []` and `max_cyclomatic: 0` on its file entries, and the detector (`refactoring.py:520-530`) gates on function count / LCOM / betweenness. Its preconditions can therefore never fire - the run was too shallow to carry the inputs the detector needs.

So the first task here is **a fresh, deeper code-metrics run**, not a cut. #819's agent deferred it deliberately for machine load (RAM-bound at 3.2-6.3 GB usable with other agents resident) and reported it instead of running it degraded.

This matters beyond the inconvenience: an agent that runs the documented command, sees 0 candidates and concludes the work is done would close a 90-file remainder on an artifact of a shallow measurement.

#### What remains

**90 candidates** (95 named by #728, minus 3 in #728's batch 1, minus 2 in #819's batch 2). They are NOT covered by `split-responsibility-ratchet.test.ts`, which pins only the files that have been through it - by construction it cannot re-derive the other 90, which is exactly why this ticket exists.

#### Method - inherited from #819 and now twice-confirmed

**Read the CONSUMERS, not the identifiers.** The tool's seams were clustering artifacts of identifier vocabulary on 3 of the 4 files inspected across both batches (a parameter name, an imported function, an exported class, a JSON field, five constant/type names). Disjoint consumer sets, genuinely shared mutable state, and transitive import weight are what distinguish a seam from a naming coincidence.

#819 added a third data point worth carrying forward: **a hand-written hypothesis is not safer than a computed one.** #819's own prose grouped `chownDependencyVolumes` with container reaping; consumers put it in provisioning. Verify every seam, whoever proposed it.

**A well-argued rejection is a valid outcome.** Record it beside that file's ratchet entry, where the next agent will hit it.

#### Mechanics

One file per commit; facade re-export from the original module so no call site changes in the same commit; lower the ratchet baseline and add the new modules in that same commit. Counts in #728 were stamped at `07a4f83c09` and the tree has moved several times - re-measure, never trust the table.

### #834 confirm the Linux CI run is green after #828 — the fixes are unprovable on Windows by construction
`priority: high` · `type: task` · `created: 2026-08-23` · `updated: 2026-08-23`

**#828 landed ten fixes for a Linux runner nobody can run here.** This ticket is the proof step, filed rather than assumed because "done means verified" and the Windows suite being green is the entire defect — it was green before #828 too.

#### Why this cannot be closed by running the tests locally

`SQLITE_READONLY_DBMOVED` is raised when an open SQLite file is unlinked. **Windows structurally cannot expose it** — an open file cannot be deleted. Several other fixes touch branches unreachable on this platform by construction (`ppid <= 1` for POSIX orphans; the non-Windows half of `useShell`). A green Windows run is not evidence for any of them.

#### What to check on the next run

Expected to go green: `issues-routes-edge-cases` (~28 tests), `workflow-fork` (9), `board-feedback-routing`, `self-project`, `orphaned-worktree-reconciler`, `stale-worktree-cleanup`, `session-artifacts`, `agent-provider`, `agent.service`, `codemod-preview-generate`, `worktree-symlink-bootstrap`, `butler-provider`, `parentless-child-server-reap`, `verify-gate-runner`, `worker-fleet-observability-followup`, plus shared's `path-key`, `db-path`, `shared-lib-single-consumer-ratchet`.

**Likely but explicitly unconfirmed** — check these three specifically: `worker-dispatch-e2e` (3), `worker-git-transport-e2e` (3), `remote-mid-session-repo-ops` (3). Their symptoms (exit code 1, empty stdout, a `waitFor` that never sees output) are exactly what the ENOENT spawn produced, and all three launch through an explicit `agentCommand` — but no one confirmed each spec path individually.

#### This gates #807

**#807's Q2 must not be acted on until this is green.** A coverage floor derived from the current figures would be set below reality, because 23 suites never executed in the run those figures came from. A floor below reality ratchets nothing.

#### Not a defect, do not chase

The `spawn cmd ENOENT` line in the original CI output is deliberate stderr noise from the *passing* `oauth-login-bootstrap.test.ts` "non-fatal (sync throw)" case.

### #840 43 unswept temp-dir prefixes the #839 guard cannot reach, plus a production .cmd written outside every swept namespace
`priority: low` · `type: task` · `created: 2026-08-24` · `updated: 2026-08-24`

**Three findings disclosed by #839 (`b2a5544c3d`) and deliberately left out of it.** Grouped because they share one root question: what should the reaper be allowed to delete?

#### 1. The production `.cmd` — the only one that is not test hygiene

`packages/server/src/services/workspace-session.service.ts:386` writes `terminal-${id}.cmd` into `%TEMP%`, **outside any swept namespace**. This is product code, not a fixture, so it accumulates on a real user's machine rather than a CI runner's. Cheapest of the three to fix and the one with an actual user on the other end — either mint it inside an `ak-` directory or clean it up on session end.

#### 2. 43 unswept non-`mkdtemp` prefixes

`.db` fixtures, the `test-db-template-<hash>` cache, and never-created paths. **The #839 guard cannot reach these by design**: the reaper is gated on `statSync(...).isDirectory()`, so loose FILES are excluded on purpose, and #839 correctly declined to widen it — sweeping files would put the persistent `test-db-template-` cache in reach of a 2-hour delete and silently destroy a build cache.

So this is a real decision, not a cleanup: either each site mints its file **inside** an `ak-` directory (the pattern #839 used for the four fleet state files), or the reaper grows a file-sweep with an explicit exclusion for the caches — which is more machinery and more ways to delete the wrong thing. **The first option is almost certainly right**; it needs no new reaper capability and the guard already covers directories.

#### 3. `test-tree-write-hermeticity.test.ts:256` — one line

Mints an unswept `hermeticity-guard-` dir. Grandfathered in the new guard's `KNOWN_UNSWEPT` only because that file was a concurrent-edit boundary during #839. **Delete the entry and rename the prefix** — the guard's staleness half will fail if the entry is left behind after the fix, which is the intended way to find this again.

#### 4. A latent coupling worth recording

`packages/e2e/global-teardown.ts:114` matches project names with `/^e2e-project-/`, coupled **by convention** to a temp-dir prefix #839 renamed. Harmless today — the adjacent `repoPath.startsWith(tmpdir())` check covers it — but the next rename could break teardown silently. Worth expressing the coupling in code rather than leaving two literals to agree by luck.

## In Progress

### #806 wire contract follow-up (780): inbound request bodies are still trusted, and 275 of 292 paths are unvalidated outbound
`priority: medium` · `type: task` · `created: 2026-08-23` · `updated: 2026-08-23`

#780 landed the OUTBOUND half: `apiFetch` no longer casts, a method+path registry validates 17 of 352 operations, and everything else goes through the named `unvalidatedResponse` seam so the gap is countable. Two halves remain, disclosed in `dc297889eb` and in the NOTE in `packages/shared/src/types/api.ts`.

**1. Inbound is entirely unvalidated.** Across the 48 route files there are 0 uses of `zValidator` and exactly 1 that imports zod at all (`routes/issue-body-schemas.ts`, from #512). Every other handler reads `await c.req.json()` and trusts the shape. `issue-body-schemas.ts` is the pattern to copy — it documents why the messages are copied verbatim rather than regenerated, which is what makes such a swap behaviour-preserving instead of a silent contract change.

**2. 275 of 292 paths are still outbound-unvalidated.** The seam is one entry per endpoint in `packages/client/src/lib/apiResponseSchemas.ts`; extending it is mechanical. Prioritise by what the client actually destructures — a schema asserting fields nobody reads is how a gate earns a reputation for false alarms and gets deleted.

Note the registry already caught two real divergences under the old cast: `PATCH /api/workspaces/:id` returns `{id}` alone while the client asserted a full workspace, and `POST /api/workspaces` answers 201-workspace OR 202-create-job.

Size: the inbound half is the bigger one and is naturally batched by route file. Neither half blocks the other.

## In Review

_(empty)_

## AI Reviewed

_(empty)_
