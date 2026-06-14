# Per-rung hands-off acceptance criteria — how a drive is graded

**What this is.** A *checkable* pass/fail definition of "the board built it hands-off"
for each rung of the [toy-project ladder](./ladder.md). The ladder says which harness path
a rung exercises; this file says **when that rung is considered passed**. Use it to grade a
drive in its `docs/board-runs/<project>.md` retro (per `#804`) — a rung's row in the ladder
flips from ⬜ to ✅ only when every applicable criterion below is **PASS**.

The point is to make "passed hands-off" objective and repeatable, so the autonomy
regression suite (re-run the ladder after any project-driver change) has a *graded* result,
not a prose impression. "Almost hands-off" is a FAIL — the criteria are deliberately strict
because the whole value of the ladder is catching the *one* manual step that crept back in.

## The hands-off bar (the operator contract)

A drive is graded against exactly one allowed human envelope, the **budget-pilot bar**:

> **register → set prefs → seed epic**, then walk away.

Concretely the operator may, *before the drive starts*:
- `POST /api/projects` to register the repo,
- set board preferences (Strategy Bullseye / provider policy, `board_autodrive_<id>=true`,
  `verify_script_<id>`, `cold_clone_check_<id>`, WIP, backlog floor),
- seed the epic + children (the fan-out DAG) and tag any issue `no-auto-start`.

Everything after "walk away" must be done by the board and its agents. **Any operator
action past that envelope is a manual-recovery event** and is counted against C5 below.

## The scorecard — six criteria

Every drive is graded on the same six criteria. Each is **PASS / FAIL / N/A**, each maps to
an *observable* signal (a board state, a git fact, or a re-runnable check) — never to a
subjective read of the transcript.

| # | Criterion | Pass condition | Where the signal lives |
|---|---|---|---|
| **C1** | **Cold build clean** | A fresh clone of `master` at the drive's final commit runs the stack's install + build to **exit 0**, with no warm `node_modules`/store and no untracked artifacts. | The cold-clone build check (`cold-clone-build-check.service.ts`, `reason: "passed"`) — or `scripts/coldclone-build-check.sh` run by hand at close-out. This is the gate the in-worktree verify can false-pass (`#783`). |
| **C2** | **Boots** | The dev server starts from the cold clone and the health URL returns **HTTP 200** within the smoke timeout, then tears down cleanly. | `runSmokeCheck` (`packages/shared/src/lib/smoke-check.ts`) HTTP-200 step. |
| **C3** | **Smoke passes** | The rung's smoke *level* passes — **skip** (CLI/lib: nothing to boot), **API** (200 on a JSON route, no render assertion), or **web** (200 **+** `<html>/<body>` render assertions). | Same `runSmokeCheck`; the level is `isLikelyBrowserStack`-derived from the stack profile (`#786`). C2 is the 200; C3 is the rung-appropriate *depth* on top of it. |
| **C4** | **N/N done** | Every seeded ticket — **including the epic/meta ticket** — is in `Done`, and the meta ticket was not parked in `Review`. No ticket stranded in In Progress / In Review / Backlog. | `GET /api/issues?projectId=` — count `Done` vs total seeded (the completion contract from the `drive-new-project` skill). |
| **C5** | **Zero manual recovery** | After "walk away", the operator made **zero** interventions: no `start-next` kicks, no manual merges/rebases, no provider re-pokes, no stop→relaunch of a hung agent, no master-side fix commits. | The retro's "residual manual effort" list MUST be empty. Every `[drive-autonomy]` obstacle that forced an operator action is a C5 FAIL for this drive (even though filing it is correct). |
| **C6** | **Zero human code edits** | Every commit on `master` between the scaffold commit and the final commit is authored by a board agent (builder / fix-and-merge / review). No operator-authored code commit; settings/pref changes don't count (they're in the envelope). | `git log <scaffold>..<final> --format='%an %s'` on `master` — every author is an agent identity; no manual code diff. |

**Grade:** a rung is **PASSED hands-off** iff C1–C6 are each PASS or N/A. Any single FAIL
means the rung is **not** passed — record it, file the obstacle, fix, re-drive.

> C5 and C6 are distinct. C6 asks *who wrote the code* (zero human edits); C5 asks *whether
> the operator had to act at all* (zero kicks/relaunches/manual merges). A drive can pass C6
> — agents wrote every line — yet fail C5 because the operator had to `start-next` a stalled
> fan-in. Both must be clean.

## Per-rung specialization — which criteria are active, and their exact pass condition

The six criteria are universal; their *concrete* pass condition varies by rung because each
rung exercises a different harness path (per the ladder's "exercises" column). For each rung:

### Rung 0 — single-file game (HTML5 canvas, no build)
- **C1 cold build**: N/A — no build step. The clone "builds" trivially (static files).
- **C2 boots / C3 smoke**: **no-web smoke (skip)** — there is no dev server / health URL. C2
  N/A, C3 = skip-level PASS (the harness correctly *skips*, doesn't hang waiting for a port).
- **C4/C5/C6**: full strength. ~10–12 tickets all `Done`, dependency-wave cascade hands-off,
  every commit agent-authored.
- *Already proven* (`star-raider-html5.md`, `space-invaders-html5.md`).

### Rung 1 — CLI tool (Rust / Go / Python)
- **C1 cold build**: PASS = cold clone runs the **non-Node** verify (`cargo test && cargo
  build` / `go test ./...` / `pytest`) to exit 0. First rung where C1 exercises a non-Node
  toolchain.
- **C2 boots**: N/A (no server). **C3 smoke**: **skip-level** PASS — the smoke check must
  *recognize* a no-web stack and skip, not stall.
- **C4**: includes the non-vitest **test scaffold** (`#793`) being present and green in the
  detected runner. **C6**: every commit agent-authored across a non-TS toolchain.

### Rung 2 — static site (Vite/Astro, no backend)
- **C1 cold build**: PASS = cold clone `pnpm install && pnpm build` (static build) exit 0.
- **C2 boots**: PASS = preview/dev server returns 200. **C3 smoke**: **web-level** — 200 **+**
  `<html>/<body>` render assertions. This is the rung that isolates the render-assertion path
  with **no DB / no API** to confound it; C3 web-render must pass *cleanly*.
- **C4/C5/C6**: full strength at ~10 tickets.

### Rung 3 — full-stack React SPA (client-only state)
- **C1 cold build**: PASS = cold clone `pnpm install && pnpm build` exit 0 (the `#783`
  esbuild/pnpm-pin class of failure must NOT recur).
- **C2/C3 smoke**: **web-level** (200 + render).
- **C4**: the larger fan-out (11–20 tickets, flat→3-tier) all `Done` — including the fan-in
  **integration** ticket and the **retro** ticket auto-started (the `#782` fan-in miss is a
  **C5 FAIL** if it needs a manual `start-next`).
- **C5**: this is the rung where C5 currently bites — budget-pilot's run failed C5 on the
  fan-in `start-next` (`#782`) and the close-out build-config fix (`#783`). Both are now
  filed/fixed; a re-drive must come back **clean** to flip rung 3 to a graded ✅.
- *Driven, not yet graded clean* (`timetracker.md`, `budget-pilot.md`, `pulse-crm.md`).

### Rung 4 — REST + DB service (Node/Java + migrated DB)
- **C1 cold build**: PASS = cold clone install + build exit 0 **and DB migrations apply** as
  part of the verify gate (schema must stand up before tests pass — Drizzle/Flyway).
- **C2 boots**: PASS = the headless API boots and the health URL returns 200. **C3 smoke**:
  **API-level** — 200 on a JSON route, **no** render assertion (the `isLikelyBrowserStack =
  false` branch). C3 must PASS at *API* depth, and must NOT erroneously demand a `<body>`.
- **C4**: ~12–16 tickets `Done`, including migration-bearing tickets that the verify gate must
  have run green. **C6**: includes migration files — agent-authored, no hand-fixed schema.

### Rung 5 — monorepo full-stack SPA (pnpm/Turbo workspaces)
- **C1 cold build**: PASS = cold clone runs **monorepo-aware install** (`pnpm install -r`
  materializing *every* workspace — `#810`) + build exit 0. The single-package rungs skip this
  install path; C1 here specifically grades that path.
- **C2/C3 smoke**: **web-level** + DB (200 + render, backend stood up).
- **C4**: ~16–24 tickets `Done`, including **cross-package dependency edges** (a client
  feature blocked on a shared type / server route) that the cascade resolved in order.
- **C5**: cross-package fan-in is the new failure surface — any manual kick to start a
  cross-package dependent is a C5 FAIL.

### Rung 6 — multi-service (2+ services + DB, orchestrated)
- **C1 cold build**: PASS = cold clone install + build of all services exit 0.
- **C2 boots / C3 smoke**: **multi-service** — *every* service boots and *each* health URL
  returns 200, in service-to-service dependency order. This pushes past the single-`devCommand`
  / single-`healthUrl` assumption in `buildSmokeCheck` today; if the harness can only express
  one bootable process, **C2/C3 FAIL by construction** until that gap is closed (this rung is
  expected to surface the next harness gap).
- **C4**: ~20–30 tickets `Done` including service-ordering dependencies.

## How to grade a drive (the close-out procedure)

Run this once, at the end of a drive, to fill the scorecard in the retro:

1. **C4 (N/N done)** — `GET /api/issues?projectId=<id>` (or `pnpm cli -- issue get` per
   ticket); confirm every seeded ticket *and the meta ticket* is `Done`.
2. **C6 (zero human code edits)** — `git log <scaffold-commit>..<final-commit> --format='%an
   %s'` on `master`; confirm every commit author is a board-agent identity and no operator
   code commit appears.
3. **C1 (cold build)** — run the cold-clone build check on the final `master` commit
   (`cold-clone-build-check.service.ts`, or `scripts/coldclone-build-check.sh`); require
   `reason: "passed"` / exit 0.
4. **C2 + C3 (boots + smoke)** — run `runSmokeCheck` against the cold clone at the rung's
   level (skip / API / web / multi-service); require the level-appropriate PASS.
5. **C5 (zero manual recovery)** — review the drive log: list every operator action taken
   *after* "walk away". The list MUST be empty. Each entry is a C5 FAIL and should be filed as
   a `[drive-autonomy]` obstacle.
6. **Record** the six-row scorecard in `docs/board-runs/<project>.md`, then update the rung's
   Status cell in `ladder.md` (✅ only if C1–C6 all PASS/N/A; otherwise leave ⬜ and note the
   failing criterion + obstacle ticket).

### Retro scorecard template

Paste this into each `docs/board-runs/<project>.md`:

```markdown
## Hands-off scorecard (per acceptance.md)

| # | Criterion | Result | Evidence |
|---|---|---|---|
| C1 | Cold build clean | PASS/FAIL/N/A | cold-clone exit code + commit |
| C2 | Boots | PASS/FAIL/N/A | smoke HTTP-200 (level: skip/API/web/multi) |
| C3 | Smoke passes | PASS/FAIL/N/A | render/API assertion result |
| C4 | N/N done | PASS/FAIL | <done>/<total> incl. meta |
| C5 | Zero manual recovery | PASS/FAIL | residual-manual list (empty = PASS) |
| C6 | Zero human code edits | PASS/FAIL | git log authors <scaffold>..<final> |

**Grade:** PASSED hands-off / NOT passed (failing: C_, obstacle #_)
```

## Why these six and not a single "it worked" flag

Each criterion isolates a different failure mode the ladder is built to catch, so a FAIL is
*attributable*:

- **C1 vs C2/C3** — a branch can verify-gate green in its warm worktree yet break on a cold
  clone (`#783`); C1 catches build/dependency rot the worktree hides, C2/C3 catch *runtime*
  breakage the build doesn't.
- **C3's level** — grading smoke at the wrong depth hides regressions both ways: demanding a
  `<body>` on a headless API rung (rung 4) is a false FAIL; accepting a 200 without render on a
  web rung (rung 2/3/5) is a false PASS.
- **C4** — premature-Done (`#535`) and a meta-ticket parked in Review (`drive-new-project`
  contract) both *look* finished; counting `Done`-incl-meta catches the silent shortfall.
- **C5 vs C6** — separating "operator had to act" from "operator had to write code" is what
  distinguishes "almost hands-off" (agents wrote everything but the operator kept it alive)
  from genuinely hands-off. The whole ladder exists to drive C5 to zero across every rung.
