---
name: drive-new-project
description: Drive a freshly-created project hands-off to a finished multi-ticket epic — the playbook for "use the board to build a new app / implement a 10+ ticket epic" tickets. Encodes the completion CONTRACT (don't mark the meta-ticket Review until the epic is N/N Done), a preflight prerequisites check, fan-out epic seeding, autodrive enablement, and a REQUIRED resident watch that recovers stalls instead of abandoning them. Use when a ticket asks you to register/scaffold a new project and take it to completion via the board.
---

You are the **epic orchestrator** for a brand-new project. Your job is NOT done when the project is set up and the first ticket is building — it is done when the **whole epic is merged to the target project's master**, or you have escalated a blocker you genuinely cannot resolve. Read `## Agent Roles` and `## Driving a different project hands-off` in `CLAUDE.md` first; this skill operationalizes them.

> **Why this skill exists.** Run #664 ("build an Atari game via the board") did the setup correctly, moved its meta-ticket to **Review at 9 minutes**, and exited — handing the epic to silent in-process autodrive with nobody watching. It *happened* to keep advancing, but the run "looked failed" and any stall (fix-and-merge zombie, codex rate-limit, hung builder) would have stranded the epic unnoticed. The two structural mistakes were: **(a) the meta-ticket left ownership** before the epic finished, and **(b) the epic was a near-linear, same-file dependency chain** so only one ticket ever built at a time. This skill prevents both.

---

## The completion contract (non-negotiable)

1. The meta-ticket stays **In Progress** until every child ticket of the seeded epic is **Done/Cancelled** AND the target project's `master` actually contains the work (verify with git, not the board snapshot — see [[pitfall_silent_merge_loss]]).
2. You MUST leave a **resident watch** running (Step 4) before you stop. Setup-then-exit is a failed run even if the board looks healthy at that instant.
3. Only after N/N Done + a clean integration pass do you move the meta-ticket to **Review** and write the run doc.

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

Seed issues **and their dependency edges in ONE `mcp__agentic-kanban__create_issues_batch` call** — pass the `dependencies` array (edges reference issues by their 0-based `issueIndex`/`dependsOnIndex` in the same call) and `parentIssueId` to link them under the epic. Issues and edges commit in a single transaction, so **never** batch-create first and POST edges in a second step: with autodrive on, a builder launches within seconds and would build against a ticket whose blocker edge isn't persisted yet (the #765 Space-Invaders failure — wave ticket built against an empty engine stub, had to be stopped/deleted/returned to Todo). Then run the **`dependency-analyzer`** skill over the seeded set and fix any chain that's accidentally linear or any two parallel tickets that overlap files. A good epic has a *wide middle*, not a ladder.

> Sanity check before enabling autodrive: on the board, count tickets whose `isBlocked == false` after the shell merges. If that's `1`, you built a chain — restructure.

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
/loop 10m  poll project <projectId>: list issues; if all child tickets of epic #<n> are Done -> report done & stop;
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

## Step 6 — Close out

Only when `GET /api/issues?projectId=` shows the epic's children all Done/Cancelled and `git -C <projectPath> log master` confirms the merges:

1. Tear down the resident `/loop`.
2. Write a short run doc under `docs/board-runs/<project>.md` (what was seeded, how many tickets, parallelism achieved, any escalations).
3. Move the meta-ticket to **Review** and commit.

---

## Anti-patterns (the #664 failure modes — do not repeat)

- ❌ Marking the meta-ticket Review at setup time. Ownership of "finish the epic" must not be dropped.
- ❌ A linear / same-file dependency chain sold as a "10+ ticket epic." It serializes and conflicts.
- ❌ Trusting `/board` over `/api/issues` + git to judge progress.
- ❌ Enabling autodrive without verifying `auto_merge`, WIP target, and profile≠mock first.
- ❌ Assuming the Conductor will drive a non-agentic-kanban project. It won't.
