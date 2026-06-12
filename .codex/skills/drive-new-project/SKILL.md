---
name: drive-new-project
description: Drive a freshly-created project hands-off to a finished multi-ticket epic — the playbook for "use the board to build a new app / implement a 10+ ticket epic" tickets. Encodes the completion CONTRACT (keep the meta-ticket In Progress until the epic is N/N Done, then drive the meta itself to Done — not parked in Review), a preflight prerequisites check, fan-out epic seeding, autodrive enablement, and a REQUIRED resident watch that recovers stalls instead of abandoning them. Use when a ticket asks you to register/scaffold a new project and take it to completion via the board.
---

You are the **epic orchestrator** for a brand-new project. Your job is NOT done when the project is set up and the first ticket is building — it is done when the **whole epic is merged to the target project's master**, or you have escalated a blocker you genuinely cannot resolve. Read `## Agent Roles` and `## Driving a different project hands-off` in `CLAUDE.md` first; this skill operationalizes them.

> **Why this skill exists.** Run #664 ("build an Atari game via the board") did the setup correctly, moved its meta-ticket to **Review at 9 minutes**, and exited — handing the epic to silent in-process autodrive with nobody watching. It *happened* to keep advancing, but the run "looked failed" and any stall (fix-and-merge zombie, codex rate-limit, hung builder) would have stranded the epic unnoticed. The two structural mistakes were: **(a) the meta-ticket left ownership** before the epic finished, and **(b) the epic was a near-linear, same-file dependency chain** so only one ticket ever built at a time. This skill prevents both.

---

## The completion contract (non-negotiable)

1. The meta-ticket stays **In Progress** until every child ticket of the seeded epic is **Done/Cancelled** AND the target project's `master` actually contains the work (verify with git, not the board snapshot — see [[pitfall_silent_merge_loss]]).
2. You MUST leave a **resident watch** running (Step 4) before you stop. Setup-then-exit is a failed run even if the board looks healthy at that instant.
3. After N/N Done + a clean integration pass, drive the meta-ticket all the way to **Done** (the project's terminal column) — **not** parked in Review — as the final step, then write the run doc. A run that ends with the meta-ticket in Review has **not** met the contract: the meta closes only once every child is merged, and so must the meta itself. (Run #1 of Space Invaders left all 10 children Done but the meta stuck in Review — the blind spot this step closes.)

---

## Step 1 — Preflight (assert, don't assume)

A new project drives hands-off only if ALL of these hold. Read `GET /api/preferences/settings`; fix any that are wrong via **`PUT /api/preferences/settings` with `curl` (Bash)** — never `Invoke-RestMethod -Put` (it silently no-ops; see CLAUDE.md PowerShell rules).

| Prereq | Check | Fix |
|---|---|---|
| Project registered | `pnpm cli -- list` shows it; resolve its `projectId` | `pnpm cli -- register <path>` or `POST /api/projects/create` (scaffold) |
| Per-project autodrive ON | `board_autodrive_<projectId> == "true"` | PUT settings `{"board_autodrive_<projectId>":"true"}` |
| Auto-merge ON + monitor strategy | `auto_merge == "true"`, merge strategy resolves to `monitor`, `auto_merge_in_review == "true"` | PUT settings accordingly |
| WIP target ≥ 2 (real parallelism) | `board_strategy_<projectId>` (`activeAgentsTarget`) or legacy `nudge_wip_limit` | set `board_strategy_<projectId>` with `activeAgentsTarget: 3, maxNewStartsPerCycle: 3, backlogFloor: 0` |
| Profile ≠ mock | `claude_profile` / codex profile is real | restore (see [[pitfall_mock_profile_from_e2e_pollution]]) |
| First-merge hazards cleared | new-project `.gitignore` dirty-main, scaffold committed | commit scaffold + `.gitignore` BEFORE seeding (see [[pitfall_new_project_gitignore_dirty_main_blocks_first_merge]]) |
| Builder guidance present | codex reads `AGENTS.md`, not `CLAUDE.md`; strip "screenshot/visually verify" from ticket bodies | see [[pitfall_codex_playwright_install_hang_visual_verify]] |

If you can't satisfy a prereq, **stop and report it** — do not proceed to seed an epic that can't drain.

---

## Step 2 — Seed a FAN-OUT epic (not a chain)

The goal of these tickets is to exercise the board at scale, so the graph must allow 2–3 builders in parallel.

1. One **shell/scaffold** ticket with no dependencies (e.g. base HTML/app skeleton, shared types/module boundaries).
2. **Several feature tickets that depend ONLY on the shell** and touch **disjoint files/modules** — these are the parallel wave. Avoid having every ticket edit one hot file (`main.js`, `index.html`); same-file dependents serialize and conflict at merge.
3. One **integration** ticket depending on the parallel wave, and a **retrospection** ticket last.

### Pre-resolve EVERY shared hot file at scaffold (not just `index.html`)

A **hot file** is any file that *more than one* wave ticket will write — especially **append-only** files (script-tag lists, module registries, **shared test/smoke files**, route tables, barrel `index` files, `package.json` deps). The shell ticket must pre-resolve ALL of them, not only the obvious entry point. The Space Invaders run (`docs/board-runs/space-invaders-html5.md`, friction #3) pre-wired `index.html` script tags and `src/*.js` stubs but left a single shared `test/smoke.test.js` — every wave ticket appended to it, producing **12 touches and a fix-and-merge thrash** that stranded three tickets and forced a manual `git merge`. The entry-point foresight was right; the blind spot was not generalizing it.

For each hot file, pick ONE of:

- **Split it — give each ticket its OWN file.** Preferred for tests: each feature ticket gets `test/<feature>.test.js`, plus a shell-owned **aggregate runner** that globs/requires them (`test/all.test.js` or an `npm test` that runs the dir). No two tickets ever touch the same test file → zero append conflicts.
- **Pre-wire ownership.** When the file genuinely can't be split (a single `index.html`, one registry), the shell pre-creates a **per-ticket stub section with clear ownership markers** (`<!-- BEGIN: invaders (ticket #N) -->` … `<!-- END: invaders -->`, or a stub `import './invaders.js'` line per ticket) so each ticket edits only its own region and diffs don't overlap.

Spell out the chosen ownership in the relevant ticket bodies ("edit ONLY `test/invaders.test.js`" / "fill ONLY the `invaders` section of `index.html`") so builders don't reach for the shared file.

Seed issues **and their dependency edges in ONE `mcp__agentic-kanban__create_issues_batch` call** — pass the `dependencies` array (edges reference issues by their 0-based `issueIndex`/`dependsOnIndex` in the same call) and `parentIssueId` to link them under the epic. Issues and edges commit in a single transaction, so **never** batch-create first and POST edges in a second step: with autodrive on, a builder launches within seconds and would build against a ticket whose blocker edge isn't persisted yet (the #765 Space-Invaders failure — wave ticket built against an empty engine stub, had to be stopped/deleted/returned to Todo). Then run the **`dependency-analyzer`** skill over the seeded set and fix any chain that's accidentally linear or any two parallel tickets that overlap files. A good epic has a *wide middle*, not a ladder.

> **Hot-file checklist (do this before enabling autodrive):** enumerate EVERY file more than one wave ticket will write — script-tag/entry files, module/route registries, barrel `index` files, **all shared test/smoke files**, `package.json`. For each, confirm it is either split per-ticket (with an aggregate runner) or pre-wired with ownership markers in the shell scaffold. If any shared file would be touched by *all* wave tickets, you have not finished scaffolding.
> Record this as a tiny ownership matrix in the shell/meta ticket before `create_issues_batch`: `file -> owning ticket(s) -> split/pre-wired region`. If a row has multiple owners and no split/region, fix the scaffold before launching builders.
>
> Sanity check: on the board, count tickets whose `isBlocked == false` after the shell merges. If that's `1`, you built a chain — restructure.

---

## Step 3 — Enable autodrive + kick the first wave

With prereqs green and the epic seeded:

- Autodrive (Step 1) makes the in-process monitor auto-start unblocked Backlog tickets and auto-merge (with fix-and-merge on conflict — `monitor-cycle.ts`). You normally don't launch workspaces by hand.
- If nothing starts within a cycle, kick it: `POST /api/projects/<projectId>/dependency-waves/start-next`, or launch the shell ticket once via `POST /api/workspaces` and let the wave cascade on its merge.
- The board UI (`/board`) can lag (stale cache, #551/#552) — **verify progress via `GET /api/issues?projectId=`**, never conclude "stuck" from `/board` alone.

---

## Step 4 — Leave a resident watch (REQUIRED)

The Conductor (`scripts/board-monitor/`) is hard-wired to *this* board and will NOT drive your new project. For another project the supported pattern is: in-process autodrive does the driving, and **you leave a lightweight watch** that polls completion and recovers stalls. Set one up before you stop:

```
/loop 10m  poll project <projectId>: list issues; if all child tickets of epic #<n> are Done -> run Step 6 close-out
           (verify master + build, then move meta-ticket #<n> to Done, NOT Review), report done & stop;
           else check for stalls (Step 5) and recover the narrowest one, then keep looping.
```

This is the new-project analogue of the `sentinel` skill. It is what turns "set it up and hope" into "owned to completion."

---

## Step 5 — Recover stalls (each loop iteration)

Autodrive advances on board events; between events, watch for these and apply the **narrowest** fix:

- **Builder running >X min with ~0 tokens** → launch-failed/stale; stop that session, rebuild the branch (see in-flight recovery rules in CLAUDE.md; one at a time).
- **In Review not merging** → check `auto_merge`/`auto_merge_in_review`; a conflict should trigger fix-and-merge automatically. If fix-and-merge **zombies** (no exit, repeated sessions), stop it and use the `unstuck` / `merge-reconciler` skill.
- **Codex rate-limit / usage stall** → the build is blocked, not progressing; see recent guardrails (#655). Switch provider/profile or pause.
- **Wave not fanning out** (only 1 active despite WIP target ≥2 and multiple unblocked) → re-check the dep graph (Step 2) and `activeAgentsTarget`.
- **Premature Done hiding work** (#535) or **scanner mass-reopen** → verify with `GET /api/issues` + git; don't churn re-merges.

Never resume many stale workspaces at once — one, then at most two more once healthy.

---

## Step 6 — Close out (drive the meta to Done, not Review)

Only when `GET /api/issues?projectId=` shows the epic's children all Done/Cancelled and `git -C <projectPath> log master` confirms the merges, run this final checklist **in order**:

1. **Verify N/N children Done** — `GET /api/issues?projectId=` shows every child of the epic in **Done/Cancelled** (count them; `done == total`). Trust `/api/issues`, not `/board` (#551/#552).
2. **Verify master advanced** — `git -C <projectPath> log master` confirms each child's work is actually on master (not just a board "merged" flag — [[pitfall_silent_merge_loss]]).
3. **Verify build green** — the integration/smoke check passes on master.
4. Tear down the resident `/loop`.
5. Write a short run doc under `docs/board-runs/<project>.md` (what was seeded, how many tickets, parallelism achieved, any escalations).
6. **Move the meta-ticket to Done** — its terminal column, NOT Review. Use `mcp__agentic-kanban__update_issue` (resolve the meta's UUID first via `get_issue`, then set `statusId`/move to the Done node) or `move_issue`. This is the contract's final state: with every child merged, the meta closes too. **Do not stop with the meta in Review.**
7. Verify the move landed: re-read `GET /api/issues?projectId=` and confirm the meta-ticket is in **Done**, then commit.

---

## Anti-patterns (the #664 failure modes — do not repeat)

- ❌ Marking the meta-ticket Review at setup time. Ownership of "finish the epic" must not be dropped.
- ❌ Ending the run with the meta-ticket parked in **Review** after N/N children are Done. The contract closes the meta to **Done** — Review is not the terminal state (the Space Invaders run #1 blind spot). Drive it to the last column (Step 6).
- ❌ A linear / same-file dependency chain sold as a "10+ ticket epic." It serializes and conflicts.
- ❌ Pre-wiring only the *obvious* entry file (`index.html`) while leaving another shared/append-only file — a single `test/smoke.test.js`, a registry, `package.json` — for every wave ticket to append to. That file becomes the new hot spot and thrashes fix-and-merge. Pre-resolve EVERY shared file, not just the entry point.
- ❌ Trusting `/board` over `/api/issues` + git to judge progress.
- ❌ Enabling autodrive without verifying `auto_merge`, WIP target, and profile≠mock first.
- ❌ Assuming the Conductor will drive a non-agentic-kanban project. It won't.
