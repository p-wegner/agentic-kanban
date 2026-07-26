---
name: drive-new-project
description: Drive a freshly-created project hands-off to a finished multi-ticket epic — the playbook for "use the board to build a new app / implement a 10+ ticket epic" tickets. Encodes the completion CONTRACT (keep the meta-ticket In Progress until the epic is N/N Done, then drive the meta itself to Done — not parked in Review), a preflight prerequisites check, fan-out epic seeding, autodrive enablement, and a REQUIRED resident watch that recovers stalls instead of abandoning them. Use when a ticket asks you to register/scaffold a new project and take it to completion via the board.
---

You are the **epic orchestrator** for a brand-new project. You are NOT done when setup is complete and the first ticket builds — you are done when the **whole epic is merged to the target project's master**, or you've escalated a blocker you genuinely cannot resolve. Read `## Agent Roles` and `## Driving a different project hands-off` in `CLAUDE.md` first; this skill operationalizes them.

> **Why this exists.** Run #664 ("build an Atari game via the board") set up correctly but moved its meta-ticket to **Review at 9 minutes** and exited — handing the epic to silent in-process autodrive with nobody watching. It happened to keep advancing, but any stall (fix-and-merge zombie, codex rate-limit, hung builder) would have stranded it unnoticed. Two structural mistakes: **(a)** the meta-ticket left ownership before the epic finished, and **(b)** the epic was a near-linear same-file chain so only one ticket built at a time. This skill prevents both.

## The completion contract (non-negotiable)

> **The engine now enforces this contract (#801).** When a first-class **Drive** record (#799) has a `metaIssueId`, the autodrive engine's `reconcileDriveCompletion` (runs each auto-merge tick) keeps the meta in **In Progress** while any child is open — pulling it back if it drifts to In Review/Done — and drives the meta itself to **Done** (then marks the drive `completed`) at N/N children Done. The steps below are still the playbook for setting that up and for driving a project *without* a Drive record; the engine is the deterministic backstop against the #664 "exit at Review" failure.

1. The meta-ticket stays **In Progress** until every child is **Done/Cancelled** AND the target project's `master` actually contains the work (verify with git, not the board snapshot — [[pitfall_silent_merge_loss]]).
2. You MUST leave a **resident watch** running (Step 4) before you stop. Setup-then-exit is a failed run even if the board looks healthy.
3. After N/N Done + a clean integration pass, drive the meta-ticket all the way to **Done** (the terminal column), **not** Review, then write the run doc. Ending with the meta in Review has NOT met the contract (Space Invaders run #1 left all 10 children Done but the meta stuck in Review — the blind spot Step 6 closes).

## Step 0 — Right-size the decomposition (cost tiers)

**Before you seed any epic, decide the granularity — it dominates cost.** Two board experiments
(2026-07-26, `docs/board-runs/greenfield-bootstrap-strategy.md`) built equivalent apps with different
decomposition strategies (same provider). Cheapest signal = total $ per KLOC; all runs ended green, so
the gaps are pure strategy overhead, not quality.

*Round 1 — three ~4k-LOC single-repo PHP apps:*

| Strategy | $ | LOC | $/KLOC |
|---|---|---|---|
| 1 mega ticket, single builder | **3.87** | 3731 | **1.04** |
| foundation → 2 parallel leaves | 10.73 | 4718 | 2.27 |
| 6 fine layer-per-ticket tickets | 12.41 | 4354 | 2.85 |

*Round 2 — three multi-repo TS apps (Hono backend + React frontend), 5k-LOC target:*

| Strategy | Tickets | $ | LOC | $/KLOC |
|---|---|---|---|---|
| repo-mega (1 mega ticket per repo) | 2 | **6.75** | 3377 | **2.00** |
| coarse sequential (found → feat → FE) | 3 | 9.83 | 3761 | **2.61** |
| contract-first fanout (contract → 3-wide wave → leaf) | 5 | 17.02 | 4095 | **4.16** |

**$/KLOC rises steeply with ticket count — confirmed twice.** The cost driver is **NOT ticket count per
se** but what each extra ticket pays: (a) a fresh builder **cold-reading the growing codebase**, (b) its
**own review session**, (c) its own worktree **setup**, (d) **fix-and-merge conflict overhead** if
parallel leaves touch a shared file. One mega ticket builds in ONE warm context and pays none of it.
**Parallel fanout buys wall-clock, not tokens** (Round 2 fanout = 2x/KLOC vs minimal decomposition).

**A single context builds to COHERENCE, not to a LOC target.** Round 2's per-repo megas plateaued at
~1.7k LOC/repo (3377 vs a 5k goal); none of the three hit 5k, and the *more*-decomposed run got closest
because each ticket adds its own slice. So the mega sweet spot is **per-context (~1.5–2k LOC/repo,
~3–4k total)**; above that you MUST decompose and pay more $/KLOC.

Pick the SMALLEST number of tickets the work allows:

- **≤ ~3–4k LOC / fits one context → ONE mega ticket + a thorough `SPEC.md`** (or, multi-repo, **one mega
  ticket per repo** — cheapest of all at $2.00/KLOC). Overrides the fan-out advice below; don't manufacture
  a 10-ticket epic for a small app.
- **Larger, optimizing tokens → a few COARSE sequential chunks** (foundation = core+domain+persistence+
  services in one ticket; then a couple of big slices). This is the value sweet spot for big apps —
  $2.61/KLOC, near the mega floor and far below fanout. **Prefer coarse-sequential over fanout by default.**
- **Larger, and wall-clock is the priority → foundation → parallel fanout** (the rest of this skill). Only
  then does the fan-out epic pay off, and only if the leaves touch **disjoint files** (Step 2's hot-file
  rule) — else you pay the fix-and-merge conflict tax (seen live: two leaves both created `FeedService`).
- **Never fine-grained layer-per-ticket chains** — serial AND expensive, zero quality gain.

**Multi-repo (backend + frontend as separate repos):** register the backend as the leading repo (the
verify gate runs there) + the frontend as a sibling (`POST /api/projects/:id/repos`, absolute path +
per-repo `setupScript`); since separate repos can't share a TS package, carry the API contract as a
`docs/api-contract.md` in the backend that frontend tickets read.

The rest of this skill (fan-out epic, resident watch, close-out) applies to the **larger** tiers. For a
small one-mega-ticket build you still do preflight (Step 1) + verify the merge landed on master + the
completion contract, but you skip the fan-out seeding.

## Step 1 — Preflight (assert, don't assume)

A new project drives hands-off only if ALL of these hold. Read `GET /api/preferences/settings`; fix wrong ones via **`PUT /api/preferences/settings` with `curl` (Bash)** — never `Invoke-RestMethod -Put` (silently no-ops; see CLAUDE.md PowerShell rules).

> **The machine-checkable half of this checklist is now an API gate (#807).** Run `GET /api/projects/<id>/drive/preflight` for a verdict — a list of named checks (each `ok`/`warn`/`block`, with `autoRepairable`) plus an overall `ready`. `POST .../drive/preflight {"autoRepair":true}` flips Drive on to fix the one-switch-fixable blockers (stack profile, verify gate, incoherent autodrive prefs) and re-evaluates. It reports — never silently works around — the human-only blockers below (no statuses, null `defaultBranch`, dirty main, credit-exhausted/`mock` provider, WIP target of 1). Use it as the fast first pass; the rows below are the manual fixes for whatever it still flags `block`.

| Prereq | Check | Fix |
|---|---|---|
| Project registered | `pnpm cli -- list` shows it; resolve its **full** `projectId` (UUID, never a truncated prefix) | `pnpm cli -- register <path>` or `POST /api/projects/create` |
| **Status columns exist** | `GET /api/projects/<id>/statuses` returns the 7 columns (not `[]`) | registration can leave them empty (#772) → `POST /api/projects/<id>/statuses` for each: Backlog/-1, Todo/0, In Progress/1, In Review/2, AI Reviewed/3, Done/4, Cancelled/5. Without statuses, `POST /api/issues/batch` 400s 'No statuses found'. |
| **Default branch set** | project record `defaultBranch` is the repo's branch (not `null`) | `PATCH /api/projects/<id> {"defaultBranch":"master"}`. Null → `POST /api/workspaces` 400s and **auto-start swallows it silently** (#772/#775) → board looks idle with no error. |
| **Tickets use an eligible issueType** | epic tickets are `task`/`bug` (NOT `feature`/`enhancement`) and titles don't start `feature:`/`enhancement:` | monitor auto-start skips feature/enhancement-typed issues (#773) → the whole epic is invisible. Seed as `task` (or convert via `PATCH /api/issues/<id> {"issueType":"task"}`). |
| **Verify gate set** | `verify_script_<projectId>` is a real build/test cmd | `PUT {"verify_script_<projectId>":"pnpm install && pnpm build"}` — the #531 quality gate runs it in the worktree post-session and WITHHOLDS merge on non-zero. This is how the dev-board's verify-before-merge ports to the toy stack ([[project_timetracker_drive_and_autonomy_obstacles]]). |
| Per-project autodrive ON | `board_autodrive_<projectId> == "true"` | PUT `{"board_autodrive_<projectId>":"true"}` |
| **Post-merge cascade ON** | `dependency_auto_chain == "true"` | PUT `{"dependency_auto_chain":"true"}`. `resolveStartPolicy.postMergeCascade` gates on it — with it OFF, `start_mode=monitor` will NOT auto-start the next wave right after a blocker merges (the regular cycle is unreliable for Backlog too). Combined with the `issueType` row above, this is the #1 reason a monitor-mode project sits idle after a merge (hit live 2026-07-26 — the whole wave stalled in Backlog). If auto-start still won't fire, drive manually: launch each unblocked ticket via `POST /api/workspaces` as its deps reach Done (auto-review/auto-merge/fix-and-merge are event-driven and work regardless). |
| Optional per-project Conductor ON | `board_conductor_<projectId> == "true"` or JSON config | PUT `{"board_conductor_<projectId>":"{\"enabled\":true,\"agent\":\"codex\",\"cadenceSeconds\":1800}"}` |
| Auto-merge ON + monitor strategy | `auto_merge == "true"`, strategy resolves to `monitor`, `auto_merge_in_review == "true"` | PUT settings accordingly |
| WIP target ≥ 2 (real parallelism) | `board_strategy_<projectId>` (`activeAgentsTarget`) or legacy `nudge_wip_limit` | set `board_strategy_<projectId>` `{activeAgentsTarget:3, maxNewStartsPerCycle:3, backlogFloor:0}` |
| Profile ≠ mock | `claude_profile` / codex profile is real | restore ([[pitfall_mock_profile_from_e2e_pollution]]) |
| First-merge hazards cleared | new-project `.gitignore` dirty-main, scaffold committed | commit scaffold + `.gitignore` BEFORE seeding ([[pitfall_new_project_gitignore_dirty_main_blocks_first_merge]]) |
| Builder guidance present | codex reads `AGENTS.md` not `CLAUDE.md`; strip "screenshot/visually verify" from ticket bodies | [[pitfall_codex_playwright_install_hang_visual_verify]] |

**Force the provider per-project (don't trust the global default).** The global `provider` is often `codex`, whose quota stalls have repeatedly stranded unattended runs. To pin claude/anth for THIS project without touching the global default, add a provider policy to `board_strategy_<projectId>`: `"providerPolicies":[{"id":"claude:anth","label":"Claude anth","provider":"claude","profileName":"anth","mode":"fill","headroomPct":0}]` — `selectProviderFromStrategy` returns the first `fill` policy, so every auto-started/relaunched workspace uses it. Verify a started workspace's returned `provider` is `claude` (else [[pitfall_post_workspaces_defaults_codex]]).

Can't satisfy a prereq → **stop and report it**; don't seed an epic that can't drain.

> **Sanity-launch the shell once and watch it.** After preflight, force one monitor cycle (`POST /api/internal/monitor-run`) and confirm the shell ticket actually auto-starts (`[monitor] Auto-started workspace…` in the dev log + a workspace appears). If it doesn't, re-check statuses/defaultBranch/issueType above — auto-start failures are SILENT (#775). Only once you've seen the monitor self-start a ticket can you trust the wave to cascade hands-off.

## Step 2 — Seed a FAN-OUT epic (not a chain)

The graph must allow 2–3 builders in parallel:
1. One **shell/scaffold** ticket, no dependencies (base app skeleton, shared types/module boundaries).
2. **Several feature tickets depending ONLY on the shell**, touching **disjoint files/modules** — the parallel wave. Don't have every ticket edit one hot file (`main.js`, `index.html`) — same-file dependents serialize and conflict.
3. One **integration** ticket depending on the wave, then a **retrospection** ticket last.

**Pre-resolve EVERY shared hot file at scaffold (not just `index.html`).** A *hot file* is any file more than one wave ticket writes — especially append-only ones (script-tag lists, module registries, **shared test/smoke files**, route tables, barrel `index` files, `package.json` deps). The Space Invaders run (`docs/board-runs/space-invaders-html5.md`, friction #3) pre-wired `index.html` + `src/*.js` stubs but left a single shared `test/smoke.test.js` — every wave ticket appended to it → 12 touches, fix-and-merge thrash, 3 stranded tickets, a manual `git merge`. The entry-point foresight was right; the blind spot was not generalizing it. For each hot file pick ONE:

- **Split it — each ticket gets its OWN file** (preferred for tests: `test/<feature>.test.js` per ticket + a shell-owned aggregate runner that globs them). No two tickets touch the same file → zero append conflicts.
- **Pre-wire ownership** when it genuinely can't be split (one `index.html`, one registry): the shell pre-creates per-ticket stub sections with ownership markers (`<!-- BEGIN: invaders (ticket #N) -->` … `<!-- END -->`, or a stub `import './invaders.js'` per ticket) so each ticket edits only its region.

Spell out ownership in each ticket body ("edit ONLY `test/invaders.test.js`") so builders don't reach for the shared file.

**Seed issues AND their dependency edges in ONE `create_issues_batch` call** — pass the `dependencies` array (edges reference issues by 0-based `issueIndex`/`dependsOnIndex` in the same call) and `parentIssueId` to link them under the epic. Edges commit in the same transaction; **never** batch-create then POST edges separately — with autodrive on, a builder launches within seconds and builds against a ticket whose blocker edge isn't persisted yet (the #765 failure: a wave ticket built against an empty engine stub, had to be stopped/deleted/returned to Todo). Then run the **`dependency-analyzer`** skill over the seeded set and fix any accidentally-linear chain or file-overlapping pair. A good epic has a *wide middle*, not a ladder.

> **Hot-file checklist (before enabling autodrive):** enumerate EVERY file >1 wave ticket writes — entry files, registries, barrel indexes, **all shared test/smoke files**, `package.json`. Confirm each is split (with aggregate runner) or pre-wired with ownership markers. Any file touched by *all* wave tickets = not finished scaffolding. Record an ownership matrix in the shell/meta ticket before `create_issues_batch`: `file -> owning ticket(s) -> split/pre-wired region`; a multi-owner row with no split/region → fix the scaffold first.
> Sanity check: after the shell merges, count tickets with `isBlocked == false`. If that's `1`, you built a chain — restructure.

## Step 3 — Enable autodrive + kick the first wave

- Autodrive (Step 1) makes the in-process monitor auto-start unblocked Backlog tickets and auto-merge (with fix-and-merge on conflict — `monitor-cycle.ts`). You normally don't launch workspaces by hand.
- If nothing starts within a cycle, kick it: `POST /api/projects/<projectId>/dependency-waves/start-next`, or launch the shell once via `POST /api/workspaces` and let the wave cascade on its merge.
- `/board` can lag (stale cache, #551/#552) — **verify progress via `GET /api/issues?projectId=`**, never conclude "stuck" from `/board` alone.

## Step 4 — Leave a resident watch (REQUIRED)

Default path: in-process autodrive does the driving, and you leave a lightweight watch that polls completion and recovers stalls. If the project opts into `board_conductor_<projectId>`, the server supervisor launches the external Conductor with that project's `.kanban/objective.md` and `.kanban/conductor/` state, so a parent watch is no longer required for routine stall recovery. For autodrive-only projects, set up the watch before you stop — the new-project analogue of the `sentinel` skill:

```
/loop 10m  poll project <projectId>: list issues; if all children of epic #<n> are Done -> run Step 6 close-out
           (verify master + build, then move meta #<n> to Done, NOT Review), report done & stop;
           else check for stalls (Step 5), recover the narrowest one, keep looping.
```

## Step 5 — Recover stalls (each loop iteration)

Autodrive advances on board events; between events, apply the **narrowest** fix:

- **Builder running >X min with ~0 tokens** → launch-failed/stale; stop that session, rebuild the branch (CLAUDE.md in-flight recovery; one at a time).
- **In Review not merging** → check `auto_merge`/`auto_merge_in_review`; a conflict should auto-trigger fix-and-merge. If fix-and-merge **zombies** (no exit, repeated sessions), stop it and use `unstuck` / `merge-reconciler`.
- **Codex rate-limit / usage stall** → build blocked; see guardrails (#655). Switch provider/profile or pause.
- **Wave not fanning out** (1 active despite WIP ≥2 + multiple unblocked) → re-check the dep graph (Step 2) and `activeAgentsTarget`.
- **Premature Done hiding work** (#535) or **scanner mass-reopen** → verify with `GET /api/issues` + git; don't churn re-merges.

Never resume many stale workspaces at once — one, then at most two more once healthy.

## Step 6 — Close out (drive the meta to Done, not Review)

Only when `GET /api/issues?projectId=` shows all children Done/Cancelled and `git -C <projectPath> log master` confirms the merges, run **in order**:

1. **N/N children Done** — `GET /api/issues?projectId=` shows every child Done/Cancelled (`done == total`). Trust `/api/issues`, not `/board` (#551/#552).
2. **Master advanced** — `git -C <projectPath> log master` confirms each child's work is on master, not just a board flag ([[pitfall_silent_merge_loss]]).
3. **Build green** — integration/smoke passes on master.
4. Tear down the resident `/loop`.
5. Write a short run doc under `docs/board-runs/<project>.md` (seeded tickets, parallelism achieved, escalations).
6. **Move the meta-ticket to Done** — its terminal column, NOT Review. `mcp__agentic-kanban__update_issue` (resolve the meta's UUID via `get_issue`, set `statusId`/move to the Done node) or `move_issue`. **Do not stop with the meta in Review.**
7. Re-read `GET /api/issues?projectId=`, confirm the meta is in **Done**, then commit.

## Anti-patterns (the #664 failure modes — do not repeat)

- ❌ Marking the meta Review at setup time — ownership of "finish the epic" must not be dropped.
- ❌ Ending with the meta parked in **Review** after N/N children Done — drive it to the last column (Step 6).
- ❌ A linear / same-file dependency chain sold as a "10+ ticket epic" — it serializes and conflicts.
- ❌ Pre-wiring only the *obvious* entry file (`index.html`) while leaving another shared/append-only file (a `test/smoke.test.js`, a registry, `package.json`) for every wave ticket — pre-resolve EVERY shared file.
- ❌ Trusting `/board` over `/api/issues` + git to judge progress.
- ❌ Enabling autodrive without verifying `auto_merge`, WIP target, and profile≠mock first.
- ❌ Assuming the Conductor will drive a non-agentic-kanban project without `board_conductor_<projectId>` enabled. Autodrive-only projects still need the lightweight watch.
