#!/usr/bin/env python3
"""Seed the [project-driver] epic + children onto the agentic-kanban board.

Theme: make the board a turnkey autonomous multi-stack project driver — generalize the
per-stack agent loop / feedback harness that today only develops the board itself.
Idempotent-ish: refuses to run if a [project-driver] EPIC already exists.
"""
import json, sys, urllib.request

BASE = "http://127.0.0.1:3001"
PROJECT = "d28f01c9-3fd3-488b-9eb4-d66268c4f7d4"
# Existing related tickets (for related_to edges)
ISSUE_782 = "b2c06aa2-5f11-4696-94cd-3dc7b1f01c60"  # runAutoStart skips fan-in dependent
ISSUE_784 = "c2592b70-8593-4beb-9baf-bb0f68c2b200"  # premature cascade (fixed) — read-side gate


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return json.loads(r.read().decode())


# --- guard against double-seed ---
existing = get(f"/api/issues?projectId={PROJECT}")
if any("[project-driver] EPIC" in (i.get("title") or "") for i in existing):
    print("EPIC already exists — aborting to avoid duplicates.")
    sys.exit(2)

EPIC_TITLE = "[project-driver] EPIC: turn the board into a turnkey autonomous multi-stack project driver"
EPIC_DESC = """**North star.** Register a project of ANY stack -> the board auto-provisions a full per-stack agent feedback harness -> it drives the project hands-off to a cold-build-clean, *running* app, with **zero human code edits** and at most a settings change from the operator.

**Why.** The board already drives its OWN development with a rich harness (incremental edit-time tests, a verify gate, dev-server + visual verification, scope-guard, code-review, the Conductor/objective loop, cold-clone build checks). But most of that harness is **hard-coded to this repo's stack** (pnpm + Hono + Drizzle + React + Vite) and to this repo specifically. Stack *detection* and the generic verify-gate *runner* already generalize; the actual **feedback loop** does not.

**This epic** generalizes that harness and adds the missing drive plumbing, exercised against an increasing **toy-project ladder**. Children are grouped:
- **Foundation:** a persisted per-project *stack profile* every harness piece reads.
- **Feedback harness:** edit-time hooks, verify gate, buildable-from-clean, dev-server, run/smoke verify, cold-clone gate, test scaffolding — all per stack.
- **Builder loop:** inject the stack's real commands, bounded self-repair on gate failure, per-stack pre-commit gate.
- **Cascade orchestration:** synchronous foundational merge + one shared readiness helper (post-#784).
- **Drive as a first-class concept:** a Drive entity, dashboard, completion-contract-in-engine, objective.md generalization.
- **Observability:** obstacle telemetry, auto-retro, per-drive review-effectiveness.
- **Operability:** one-switch Drive mode, drive preflight.
- **Toy-project ladder:** the autonomy test suite + per-rung acceptance criteria.

Grounding (generalizability blockers, C-rated): `smart-hooks-config.json`, `scripts/board-monitor/objective.md`, the `dev-server`/`e2e-author` skills, `ensurePnpmBuildApproval` (`packages/server/src/services/project-scaffold.ts`). Already-generic to build on: `detectProjectMarkers`/`deriveVerifyScript` (`project-setup.service.ts`), `verify-gate-runner.js`, scaffolding (`project-scaffold.ts`), the in-process monitor.

Constraint honored by the operator: drive projects by changing **board settings only** — the board and its agents do the building.
"""

# children: (key, title, type, priority, [depends_on keys])
C = [
 # ---- Foundation ----
 ("profile",
  "[project-driver] Stack profile: detect, persist & expose a per-project stack descriptor",
  "feature", "high", [],
  """**Foundation for the whole epic.** Today `detectProjectMarkers()` + `deriveVerifyScript()` (`packages/server/src/services/project-setup.service.ts`) derive stack facts ad-hoc per call and don't persist them. The feedback harness needs ONE durable descriptor every other piece reads.

**Build.** A `project_stack_profile_<projectId>` (JSON pref or column) populated at registration from marker detection + LLM fallback, containing: package manager, monorepo layout (workspaces), and commands for build / test / quick-test / lint / typecheck / dev, plus dev health URL + port, `isWeb`, and the test directory + runner. UI in Project Settings to view/override; expose via `GET /api/projects/:id/stack-profile`.

**Acceptance.** Registering any of {node single, pnpm monorepo, cargo, go, python, java/gradle} yields a populated profile; downstream harness pieces (#hooks, #verify, #dev-server, #buildclean) read it instead of re-deriving."""),

 # ---- Feedback harness ----
 ("hooks",
  "[project-driver] Generic edit-time feedback hooks generated from the stack profile",
  "feature", "high", ["profile"],
  """Replace the hard-coded `.claude/hooks/smart-hooks-config.json` (encodes THIS repo's `pnpm --filter @agentic-kanban/server test` + `packages/**` patterns — C-rated) with a **generated per-project** `.claude/smart-hooks-rules.json` (file-pattern -> quick build/test/typecheck command) derived from the stack profile. A driven project's builder then gets incremental PostToolUse/Stop feedback like board builders do.

**Acceptance.** Editing a source file in a driven non-TS project triggers that stack's quick check; rules regenerate when the profile changes; the generic runner stays project-agnostic."""),

 ("verify",
  "[project-driver] Auto-populate & activate the verify gate at registration",
  "feature", "high", ["profile"],
  """`generateVerifyScript()` runs detection but `verify_script_<projectId>` is only *proposed*, not saved/active. The verify gate is the **keystone merge gate** (it withholds `readyForMerge` in `exit-workflow.ts`), so a drive needs it live from ticket #1.

**Build.** Persist the derived verify script at registration; surface + allow override in Settings; no-op safely if detection is empty.

**Acceptance.** A freshly-registered project has a non-empty `verify_script` that runs on review-session exit and gates auto-merge; visible/editable in Settings."""),

 ("buildclean",
  "[project-driver] Package-manager-agnostic \"buildable-from-clean\" scaffold",
  "feature", "high", ["profile"],
  """`ensurePnpmBuildApproval()` (`packages/server/src/services/project-scaffold.ts`) only makes **pnpm** projects build on a fresh clone (the #783 fix: pin `packageManager`, approve native builds). Generalize per stack profile: npm/yarn/bun engine+lockfile pinning, cargo/go/python equivalents.

**Acceptance.** `git clone <fresh> && <stack build>` -> exit 0 for each supported stack, without manual approval prompts."""),

 ("devserver",
  "[project-driver] Per-stack dev-server capability — boot any driven project",
  "feature", "high", ["profile"],
  """Generalize the `dev-server` skill (C-rated: hard-coded 3001/5173 + Vite/Hono worktree scheme). Derive start command + health URL + port from the stack profile (or `dev_command`/`health_url` prefs). The board (and builders) can then boot ANY driven project headlessly to confirm it runs.

**Acceptance.** The board can start + health-check a node web app, a python service, etc., headless and `windowsHide`, killing only its own port owner — never all node."""),

 ("smoke",
  "[project-driver] Per-stack run/smoke verification harness",
  "feature", "medium", ["profile", "devserver"],
  """Generalize `frontend-smoke.ps1` + playwright into a board-driven \"does it boot and respond/render\" smoke check, parameterized by the stack profile's health URL + a couple of generic assertions. Runs as part of review for web/service projects; no-op for libraries/CLIs.

Complements the existing ticket \"Keep visual verification out of the build prompt (visual_verification_mode)\" — that makes visual-verify board-owned; THIS builds the generalized harness it would invoke.

**Acceptance.** A web toy-project's review includes an automated boot + HTTP-200/render check; a CLI/library project skips it cleanly."""),

 ("coldclone",
  "[project-driver] Cold-clone build check as a generated per-stack review gate",
  "enhancement", "medium", ["profile", "buildclean"],
  """Generalize the one-off `scripts/seed-*`/cold-clone validation (used to prove #783) into a board **review gate**: clone the branch to a temp dir, run the stack profile's build, fail review on non-zero. Catches \"builds in the junctioned worktree but breaks on a fresh clone\" — the exact #783 class.

**Acceptance.** A branch that builds in-worktree but breaks on a fresh clone is caught at review, not after merge."""),

 ("testscaffold",
  "[project-driver] Stack-aware test scaffolding (generalize e2e-author)",
  "enhancement", "low", ["profile"],
  """The `e2e-author` skill assumes `packages/e2e/tests/` + the worktree port scheme (C-rated). Make test location + runner come from the stack profile so driven projects can get a runnable test scaffold in their actual layout.

**Acceptance.** Scaffolds a runnable test in the project's real test dir/runner (pytest, cargo test, vitest, go test, ...)."""),

 # ---- Builder loop ----
 ("inject",
  "[project-driver] Inject the stack's exact build/test/dev commands into the builder context",
  "feature", "high", ["profile"],
  """Board builders know `pnpm test:mine`; driven-project builders **guess** their commands. Inject the stack profile's commands into the builder's context primer / `CLAUDE.local.md` so the agent runs the right feedback commands from turn 1.

**Acceptance.** Builder transcripts on a driven project show it running the project's real test/build/dev command, not invented ones."""),

 ("selfrepair",
  "[project-driver] Bounded self-repair loop on verify-gate failure",
  "feature", "medium", ["verify"],
  """When the verify gate fails, feed the captured failure back to the builder for a bounded (N-attempt) self-repair pass before giving up — adopt `fix-and-merge`'s concept at the verify stage instead of stranding the ticket.

**Acceptance.** A build-breaking diff is auto-repaired within N attempts, or escalated with the captured error attached; no silent strand."""),

 ("scopegate",
  "[project-driver] Per-stack pre-commit scope/test gate (generalize scope-guard)",
  "enhancement", "low", ["profile"],
  """Generalize the `scope-guard` skill to run the stack profile's quick-test subset + scope check before a builder commits, in any project (not just the TS monorepo).

**Acceptance.** Runs the project's fast checks pre-commit and flags out-of-scope files for any stack."""),

 # ---- Cascade orchestration (post-#784) ----
 ("syncmerge",
  "[project-driver] Synchronous foundational merge to eliminate pre-merge cascades",
  "bug", "high", [],
  """Structural complement to #784's read-side `mergedAt` gate. When a **no-dependency foundational** ticket (the scaffold/shell) completes, merge it **synchronously** (or hold the cascade) so dependents never cut from a pre-merge base even on the very first cascade cycle — fix-direction (c) from #784. #784 makes the cascade *wait*; this makes the foundational merge *land promptly* so the wait is short.

**Acceptance.** In a shell -> tier-1 graph, tier-1 worktrees are ALWAYS cut from a base that already contains the shell scaffold; no re-scaffold, no Done-but-unmerged shell."""),

 ("readiness",
  "[project-driver] Extract one shared computeBlockerReadiness for runAutoStart + dependency-wave",
  "enhancement", "medium", [],
  """`runAutoStart` (`monitor-auto-start.ts`) and `startNextDependencyWave` (`dependency-wave.service.ts`) compute dependency readiness **differently** — the root of the #535/#537/#782/#784 family. Extract ONE shared `computeBlockerReadiness` (terminal-status AND merged-to-base, via `mergedAt`/`isDirect`) used by both paths, so the whole class is fixed in one place.

Related: #782 (fan-in dependent not auto-started), #784 (premature cascade, fixed read-side).

**Acceptance.** Both paths call the same helper; its tests cover the #782 fan-in and the #784 closed-but-unmerged cases."""),

 # ---- Drive as a first-class concept ----
 ("driveentity",
  "[project-driver] First-class \"Drive\" entity",
  "feature", "medium", [],
  """A drive lives only in the `drive-new-project` skill + agent memory today. Add a **Drive** record (projectId, meta/epic issueId, target, completion contract, status, startedAt/finishedAt) so a drive is observable, resumable, and queryable rather than implicit.

**Acceptance.** Starting a drive creates a Drive record; its state is queryable via API/MCP and survives a server restart."""),

 ("dashboard",
  "[project-driver] Drive dashboard: per-drive progress, tier graph, build-clean status",
  "feature", "low", ["driveentity"],
  """UI for a running drive: N/N tickets done, the dependency tier graph, current stalls, last cascade event, and cold-build-clean status.

**Acceptance.** A running drive shows live progress + an obstacle feed at a glance."""),

 ("contract",
  "[project-driver] Encode the completion contract in the autodrive engine",
  "feature", "medium", ["driveentity"],
  """Move the `drive-new-project` **completion contract** (don't drop the meta/epic to Review until N/N children are Done; meta -> Done only when the epic is complete) from the skill into the autodrive engine. Born from #664 (Star Raider exited at Review with the epic unfinished).

**Acceptance.** The engine refuses to mark a drive's meta Done (or parks it in Review) while children remain open; it drives the meta itself to Done at N/N."""),

 ("objective",
  "[project-driver] Generalize or formally retire objective.md for driven projects",
  "enhancement", "low", [],
  """`scripts/board-monitor/objective.md` is hard-coded to agentic-kanban (project name, cwd, API port 3001, board skill names — C-rated). Either template-substitute it from the stack profile + Strategy Bullseye, OR formally document that **driven projects use the in-process engine** (decision 006) and drop the Conductor dependency for them.

**Acceptance.** A non-agentic-kanban project drives hands-off with no hand-authored objective.md."""),

 # ---- Observability / compounding ----
 ("telemetry",
  "[project-driver] Structured drive-obstacle telemetry",
  "enhancement", "medium", ["driveentity"],
  """Emit structured events for drive friction — premature cascade, stall, re-scaffold, silent merge loss, verify-gate failure, over-launch — so obstacles are **detected**, not just discovered by hand in a retro. Distinct from the existing \"Autodrive stall watchdog\" (that warns on no-progress; this is a typed event stream).

**Acceptance.** Friction events are logged structured + feed the drive dashboard and a queryable log."""),

 ("retro",
  "[project-driver] Auto-generate a per-drive retro doc",
  "enhancement", "low", ["driveentity", "telemetry"],
  """At drive completion, generate `docs/board-runs/<project>.md` from the telemetry (obstacles, cascade events, cold-build result, N/N, providers, cost) instead of hand-authoring it (as `docs/board-runs/pulse-crm.md` was).

**Acceptance.** Completing a drive writes a retro doc automatically from the event log."""),

 ("revieweff",
  "[project-driver] Per-drive review-effectiveness summary",
  "enhancement", "low", ["driveentity"],
  """Surface review coverage / bounce-back / scorecard distribution scoped to a single drive (generalize `pnpm cli -- session review-effectiveness`).

**Acceptance.** A drive reports its review effectiveness (reviews run, reviews that bounced, merged-without-review)."""),

 # ---- Operability ("I only change settings") ----
 ("oneswitch",
  "[project-driver] One-switch \"Drive this project\" toggle",
  "feature", "high", ["profile", "verify"],
  """Collapse the multi-pref dance (`board_autodrive_<id>`, auto_review, auto_merge, verify gate, stack profile, planMode-off, provider/profile) into ONE project-level **Drive** toggle that sets them all coherently — so the operator changes a single setting and the board does the rest (the core operability promise of this epic).

**Acceptance.** Flipping one switch makes a registered project build hands-off; no per-ticket fiddling; flipping it off restores triage mode."""),

 ("preflight",
  "[project-driver] Drive preflight check: assert hands-off prerequisites before starting",
  "feature", "medium", ["profile", "verify", "oneswitch"],
  """Encode the `drive-new-project` preflight as an API/engine gate: verify gate set, stack profile present, agent-artifact `.gitignore` committed (no dirty-main), provider healthy / not credit-exhausted, autodrive prefs coherent. Block or auto-repair before a drive starts.

**Acceptance.** Starting a drive on an unprepared project reports exactly what's missing (or auto-fixes it) instead of stalling silently mid-drive."""),

 # ---- Toy-project ladder ----
 ("ladder",
  "[project-driver] Define the toy-project ladder (autonomy test suite)",
  "task", "medium", [],
  """Document a sequence of increasingly large target projects across stacks — e.g. CLI tool -> static site -> REST+DB service -> full-stack SPA -> multi-service — each chosen to exercise a DIFFERENT harness path (no-web smoke, web smoke, DB migrations, monorepo install, multi-service orchestration).

**Acceptance.** `docs/board-runs/ladder.md` lists the rungs, their stacks, and which harness pieces each exercises; it is the board's autonomy test suite."""),

 ("acceptance",
  "[project-driver] Per-rung hands-off acceptance criteria",
  "task", "low", ["ladder"],
  """Define what \"the board built it hands-off\" means per ladder rung: cold build clean, boots, smoke passes, N/N done, **zero human code edits**, no manual recovery.

**Acceptance.** Each ladder rung has a checkable pass/fail definition used to grade a drive."""),

 # ---- Stack-specific gaps (from inventory) ----
 ("setupmono",
  "[project-driver] Persist setup_script + monorepo-aware install from detection",
  "enhancement", "medium", ["profile"],
  """Detection generates a setup script but monorepo install (pnpm `-w`, cargo workspaces, gradle multi-module) isn't modeled. Persist `setup_script` at registration and handle workspace installs so deps are ready before the first build.

**Acceptance.** A monorepo toy-project installs all workspaces before the first build; no per-package install dance."""),

 ("gitignore",
  "[project-driver] Per-stack agent-artifact .gitignore (prevent dirty-main merge blocks)",
  "enhancement", "medium", ["profile"],
  """`ensureAgentGitignore()` adds TS/node artifacts only; non-TS stacks leave build output (`target/`, `__pycache__/`, `dist/`, `*.class`) untracked -> dirty-main blocks auto-merge (a recurring obstacle on fresh projects). Extend per stack profile.

**Acceptance.** A cargo/python/java toy-project's build output never blocks an auto-merge via dirty-main."""),

 ("repairgate",
  "[project-driver] Per-stack verify-gate auto-repair (generalize ensurePnpmBuildApproval)",
  "enhancement", "low", ["profile", "buildclean"],
  """`exit-workflow.ts` auto-repairs pnpm build-approval before running the verify gate; dispatch per stack profile instead of assuming pnpm, so the pre-verify auto-repair is correct (or a clean no-op) for non-pnpm projects.

**Acceptance.** The pre-verify auto-repair is stack-correct or a no-op for every supported stack."""),
]

# --- create epic ---
epic = post("/api/issues", {"projectId": PROJECT, "title": EPIC_TITLE, "description": EPIC_DESC,
                            "issueType": "task", "priority": "high"})
epic_id = epic.get("id") or epic.get("issue", {}).get("id")
print("EPIC:", epic_id, "#", epic.get("issueNumber"))

# --- create children in batch ---
batch = [{"title": t, "description": d, "issueType": ty, "priority": pr} for (k, t, ty, pr, deps, d) in C]
res = post("/api/issues/batch", {"projectId": PROJECT, "issues": batch})
created = res if isinstance(res, list) else res.get("issues") or res.get("created") or res
ids = {}
for (spec, row) in zip(C, created):
    ids[spec[0]] = row.get("id")
print("children created:", len([v for v in ids.values() if v]))

# --- wire edges: epic parent_of each child, depends_on per graph, related_to existing ---
edges = []
for k, v in ids.items():
    edges.append({"issueId": epic_id, "dependsOnId": v, "type": "parent_of", "action": "add"})
for (k, t, ty, pr, deps, d) in C:
    for dep in deps:
        edges.append({"issueId": ids[k], "dependsOnId": ids[dep], "type": "depends_on", "action": "add"})
# related_to existing tickets
edges.append({"issueId": ids["readiness"], "dependsOnId": ISSUE_782, "type": "related_to", "action": "add"})
edges.append({"issueId": ids["readiness"], "dependsOnId": ISSUE_784, "type": "related_to", "action": "add"})
edges.append({"issueId": ids["syncmerge"], "dependsOnId": ISSUE_784, "type": "related_to", "action": "add"})

dep_res = post("/api/issues/dependencies/batch", {"edges": edges})
print("edges added:", dep_res.get("added"), "skipped:", len(dep_res.get("skipped", [])))
print("DONE. epic #%s + %d children." % (epic.get("issueNumber"), len(C)))
