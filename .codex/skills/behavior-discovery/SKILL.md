---
name: behavior-discovery
description: Build a high-confidence model of a software system's EXTERNALLY OBSERVABLE behaviour — capabilities, actors, permissions, entry points, workflows, state transitions and error states — by combining many evidence sources (domain docs, OpenAPI/GraphQL schemas, source, routing, running-UI exploration, existing tests, git history) and degrading gracefully when some are absent. Infers business semantics; never paraphrases code. Marks unknowns explicitly instead of guessing. Output is the shared `_behavior-model.json` that the coverage-intelligence and e2e-test-author skills consume. Use when the user asks to "model what the app does", "discover observable behaviour", "build a verification/behaviour model", "explore the running app and map its capabilities", or as phase 1 of an end-to-end verification effort.
---

# behavior-discovery

Build a **living model of what the application does that an outside actor can observe** —
the spine every coverage decision and generated test hangs off. This is *not* code
documentation (that is the `domain-docs` skill) and *not* test generation (that is
`e2e-test-author`). It is the inferred, evidence-backed answer to: *what are the assertable
behaviours of this system, who can trigger them, through which entry points, in which
states, and where does it fail?*

**The bar — infer business semantics, never paraphrase.** "Behaviour: `POST /api/workspaces`
inserts a row" is worthless. "Behaviour: creating a workspace provisions an isolated worktree
and launches an AI agent against a ticket; the diff becomes reachable once it commits" is the
goal. Every behaviour is **observable** (assertable from outside the process) and carries
`file:line` evidence.

**Graceful degradation is the whole design.** Combine sources; never depend on one. If rich
docs exist, bind to and cross-check them. If none do, infer from code + routing + exploring
the running app. Always record *which* sources were available (`evidence_sources`) and lower
`confidence` when a behaviour rests on weak evidence. See `references/degradation-ladder.md`.

Output: `docs/verification/_behavior-model.json` (+ per-capability `.md` renders), conforming
to **`../coverage-intelligence/references/verification-model.md`** (the shared schema — read it
first). Re-running **updates** the model: refresh changed capabilities (`analyzed_sha` drift),
resolve `unknowns`, never rewrite wholesale.

---

## Phase 0 — Inventory the evidence (what do we actually have?)

Probe each source; record availability. This decides the rung on the degradation ladder.

| Source | Probe | Yields |
|--------|-------|--------|
| Domain docs | `docs/domain/_plan.json` + module docs present? | capability spine, workflows, entry points, invariants, risks — **reuse, don't redo** |
| Requirements | `docs/prd/`, ADRs (`docs/decisions/`), user stories, RFCs | intended behaviour to compare against |
| API schema | OpenAPI/GraphQL spec, or Hono/Express route files | entry points + request/response contracts |
| Source | repo tree, routing, permission/role checks, domain services, DB schema | behaviour + actors + state when no schema |
| Running app | is the dev server up? (`dev-server` skill / health check) | the ground truth — explore it |
| Existing tests | `packages/e2e`, unit/integration suites | behaviours someone already considered worth asserting |
| History | `git log`, churn (code-metrics), issue/bug tracker | risk + regression-prone areas |

If `docs/domain/_plan.json` exists, **the capability list starts from it** — you are adding a
verification lens to an existing capability map, not inventing one. If it doesn't, derive a
provisional capability set the way `domain-docs` Phase 1 does (code-metrics clusters +
directory tree + capability inference) — or just run `domain-docs` first and come back.

---

## Phase 1 — Seed capabilities from the strongest available source

Produce the capability list (8–25 business capabilities, not technical folders; prefer
DDD-style bounded contexts). For each, pull what the strong sources already give you:
- from domain docs: purpose, workflows, entry points, invariants, risks;
- from routes/schema: the API/MCP/CLI entry points and their contracts;
- from code-metrics: `risk` seed (blast radius, churn) and the logic-bearing files.

For a **poorly-structured** system, also record how the inferred capability maps onto the
physical files (the domain-docs "File Topology" idea) — testers need to know where to look.

---

## Phase 2 — Add the verification lens (the new work)

The domain docs tell you *what a capability means*; this phase extracts what is **assertable**.
For each capability, fan out one **`general-purpose`** subagent per capability (in waves),
briefed by `references/exploration-brief.md`. Each subagent reads the capability's code +
docs + routes + tests and, where the app is running, **explores it** (via `playwright-cli` /
`ui-explorer` for UI, direct API calls for endpoints), then fills the `_behavior-model.json`
capability record:

- **behaviors** — atomic, observable, assertable units with stable ids (`<cap>.<verb>.<object>`),
  preconditions, the observable outcome, evidence, the coverage dimensions they belong to, and
  honest `risk`/`confidence`.
- **actors** — who/what can drive it (human roles, automation, agents, external callers).
- **entry_points** — every external trigger: API, UI control, MCP tool, CLI, webhook, cron.
- **permissions** — the actor × behaviour allow/deny matrix, *if the system has roles*. (This
  app is single-user/local — record that and keep the matrix trivial rather than inventing RBAC.)
- **state_model** — the testable state machine when one exists (workspace lifecycle, workflow
  graph, issue status). Transitions are behaviours too.
- **error_states** — observable failure modes worth asserting (409 on busy, validation errors,
  timeouts, conflict markers). These are the highest-yield, lowest-covered behaviours.
- **unknowns** — anything you could not determine. **Explicit, never guessed.** Each unknown is
  a lead the coverage skill or a future run resolves.

### Running-app exploration (when the server is up)
Use `ui-explorer` / `playwright-cli` to crawl navigation, inspect routes, detect forms/dialogs/
tables, identify CRUD flows, filters, search, auth, error states, responsive/feature-flag/
localization variants. **Construct behaviours from observation**, cross-checked against code.
Anything seen in the UI but not found in code (or vice-versa) is a finding — flag it, don't
smooth it over. Don't run `playwright install`; don't leave the browser open; delete screenshots.

---

## Phase 3 — Assemble + cross-check

- Write `docs/verification/_behavior-model.json` (validate against the shared schema).
- Render per-capability `docs/verification/<slug>.md` (behaviours table + actors + states +
  entry points + unknowns) so the next skill's agents read cheaply.
- **Cross-source contradiction check** (cheap, high value): for each capability, do the docs,
  the code, and the running app agree? List every disagreement as a `documented-missing` or
  `undocumented-implemented` candidate and hand it to coverage-intelligence. These are real
  bugs-or-doc-drift, surfaced for free.
- Append this run to `docs/verification/_verification-log.md` (sources used, capabilities
  refreshed, unknowns opened/closed) so the next run is forced onto fresh ground.

---

## Rules
- **Observable or it's not a behaviour.** If no outside actor can assert it, it belongs in
  domain docs, not here.
- **Infer meaning; cite evidence.** Every behaviour carries `file:line`. Mark genuine guesses
  `confidence: low` and put the open question in `unknowns`.
- **Degrade loudly.** Record `evidence_sources`; never let a code-only inference masquerade as
  observed truth.
- **Reuse, don't recompute.** Bind to `docs/domain/` and `code-metrics-out/` when present.
- **Scale by fan-out.** Orchestrator plans + assembles; subagents read/explore per capability.
- **Unknowns are deliverables.** A named gap in understanding is worth more than a confident guess.

## Reference files
| File | Use |
|------|-----|
| `../coverage-intelligence/references/verification-model.md` | the shared schema (READ FIRST) |
| `references/exploration-brief.md` | Phase 2 — the per-capability discovery subagent prompt |
| `references/degradation-ladder.md` | the source-availability ladder + how confidence degrades |
