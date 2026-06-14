# The toy-project ladder — the board's autonomy test suite

**What this is.** A deliberately-ordered sequence of target projects, each one bigger than
the last AND chosen to exercise a *different* path through the board's project-driver harness.
Drive them in order: each rung that passes hands-off proves a harness capability; the first
rung that needs hand-holding is the next thing to fix. This is the board's **autonomy
regression suite** — re-run the ladder after any project-driver change and the rung that
breaks tells you what regressed.

It is not just "ever-larger apps". Size grows down the ladder, but the design constraint is
**stack/path diversity**: each rung is the smallest project that forces a harness branch the
rungs above it never hit (no-web smoke, web smoke, DB migrations, monorepo install,
multi-service orchestration). A 30-ticket React SPA that re-walks the same harness path as a
16-ticket one is *not* a new rung.

## The harness pieces a rung can exercise

Each rung's "exercises" column references these pieces, all derived from the project's #786
**stack profile** (`packages/server/src/services/stack-profile.service.ts`) and consumed
across registration → build → review → merge:

| Piece | Where | What it does | When it branches |
|---|---|---|---|
| **Setup / install** (`#810`) | `deriveSetupScriptFromProfile` → `setup_script` | Installs deps in a fresh worktree before the first build. **Monorepo-aware**: `pnpm install -r`, gradle multi-module `assemble` — must materialize *all* workspaces, not just the root. | single-package vs **monorepo / multi-module install** |
| **Verify gate** (`#788`) | `deriveVerifyScriptFromProfile` → `verify_script_<id>` | The keystone auto-merge gate: `testCommand && buildCommand`. A non-zero exit withholds `readyForMerge` (`exit-workflow.ts`). | always on; the **command shape** differs per stack (e.g. `cargo test && cargo build`, `pnpm install && pnpm build`, `go test ./...`) |
| **Smoke check** (`#791`) | `buildSmokeCheck` → `runSmokeCheck` (`packages/shared/src/lib/smoke-check.ts`) | Boots the dev server, polls a health URL for HTTP-200 + (browser) `<html>/<body>` render assertions, tears it down. | **no-web smoke (skip)** for CLI/lib · **API smoke** (200, no body) for headless services · **web smoke** (200 + render) for browser UIs |
| **Test scaffold** (`#793`) | `deriveTestScaffold` → `writeTestScaffold` | Writes one runnable, trivially-green test into the project's *real* test dir in its detected runner's syntax (vitest/pytest/cargo/go/junit…). | per **runner**; null (skip) for unknown stacks |
| **Edit-time rules** (`#787`) | `buildSmartHooksRules` → `.claude/smart-hooks-rules.json` | Per-edit PostToolUse/Stop quick checks (typecheck, quick tests) for the driven project's builder. | per **stack** source-glob set |
| **Dependency-wave cascade** | monitor `runAutoStart` / `dependency-waves/start-next` | Fans out builders as blockers merge; respects the dependency DAG (shell → features → integration). | **flat fan-out** vs **multi-tier DAG** vs **fan-in** (`#782`/`#784` friction lives here) |

## The rungs

| # | Rung | Stack | Scale | Harness path it newly exercises | Status |
|---|---|---|---|---|---|
| 0 | **single-file game** | HTML5 + canvas, no build (`star-raider`, `space-invaders`) | 10–12 tickets, linear/single-file | baseline: dependency-wave cascade, no install, no real verify, **no smoke** | ✅ driven (`star-raider-html5.md`, `space-invaders-html5.md`) |
| 1 | **CLI tool** | Rust (`cargo`) **or** Go (`go mod`) **or** Python (`pytest`) | ~8–10 tickets | **No-web smoke (skip path)** + a **non-Node verify** (`cargo test && cargo build` / `go test ./...` / `pytest`) + **non-vitest test scaffold** (`#793` cargo/go/pytest syntax) + non-TS edit-time rules (`#787`). First rung off the Node/web happy path. | ⬜ not yet driven |
| 2 | **static site** | Vite/Astro static build, no backend | ~10 tickets | **Web smoke with render assertions** (`<html>/<body>`) on a Node browser stack, but **no DB / no API** — isolates the smoke-check render path from data concerns. | ⬜ not yet driven |
| 3 | **full-stack React SPA** (client-only state) | Vite + React + TS + Tailwind + Zustand + router | 11–20 tickets, fan-out → multi-tier | **Web smoke** + **flat then 3-tier dependency cascade** at scale. The premature-cascade / fan-in friction (`#782`, `#784`) surfaces here. | ✅ driven (`timetracker.md` 11, `budget-pilot.md` 16, `pulse-crm.md` 20/3-tier) |
| 4 | **REST + DB service** | Node (Hono/Express) **or** Java (Spring Boot) + a migrated DB (Drizzle / Flyway) | ~12–16 tickets | **DB migrations** in the verify gate (schema must apply before tests pass) + **API smoke** (HTTP-200 on a JSON route, *no* render assertion — the `isLikelyBrowserStack=false` branch). First rung where the verify gate must stand up a stateful backend. | ⬜ not yet driven |
| 5 | **monorepo full-stack SPA** | pnpm/Turbo monorepo: `packages/client` + `packages/server` + shared | ~16–24 tickets | **Monorepo-aware install** (`pnpm install -r` materializing every workspace — `#810`) + **cross-package dependency edges** (a client feature blocked on a shared type or server route) + web smoke + DB. Exercises the install path the single-package rungs skip. | ⬜ not yet driven |
| 6 | **multi-service** | 2+ services (e.g. API + worker, or two HTTP services) + DB, orchestrated | ~20–30 tickets | **Multi-service orchestration**: more than one bootable process, more than one health URL, service-to-service dependency ordering. Pushes smoke/verify beyond the single-`devCommand`, single-`healthUrl` assumption baked into `buildSmokeCheck` today — likely surfaces the next harness gap. | ⬜ not yet driven |

## How to use the ladder

- **Drive top-down.** Start at the lowest rung not yet proven hands-off. A rung is "passed"
  when the board takes it from a bare repo to a clean-building `master` with no manual
  intervention beyond *register → set prefs → seed epic* (the budget-pilot bar).
- **Each rung writes a `docs/board-runs/<project>.md` retro** (per `#804`) recording what was
  hands-off, what needed a manual kick, and which `[drive-autonomy]` obstacles it surfaced.
  The rung's row above links to that retro.
- **A regression = the highest passed rung that now needs a manual step.** Bisect harness
  changes against the rung whose path they touch (use the "exercises" column to map a change
  to the rung that tests it).
- **Coverage gaps are the unproven rows.** As of this writing, rungs **1 (CLI / non-Node)**,
  **2 (static site)**, **4 (REST+DB)**, **5 (monorepo)**, and **6 (multi-service)** have not
  been driven — they are the open frontier of the autonomy suite. Rungs 0 and 3 are proven;
  the diversity gap is everything *off* the Node-web SPA path.

## Why these rungs and not others

Each step changes exactly one harness dimension relative to the rung above, so a failure is
attributable:

- **0 → 1**: drop the browser, drop Node → forces the **smoke-skip** branch and the **non-Node
  verify + scaffold** branches. Smallest possible project that leaves the happy path.
- **1 → 2**: add a browser back, keep it static → isolates the **web-smoke render assertion**
  with no backend to confound it.
- **2 → 3**: add stateful client + scale + a dependency DAG → the **cascade** under load
  (already the most-driven rung; its friction is well-mapped).
- **3 → 4**: add a database and a headless API → forces **DB migrations in verify** and the
  **API-smoke (no-render) branch**.
- **4 → 5**: split into workspaces → forces **monorepo install** and **cross-package deps**.
- **5 → 6**: split into independently-bootable services → forces **multi-service
  orchestration**, the one path the current single-`devCommand` smoke check cannot express.
