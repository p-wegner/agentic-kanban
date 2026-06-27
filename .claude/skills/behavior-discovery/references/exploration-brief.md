# Discovery subagent brief — one capability → its observable-behaviour record

You are mapping the **externally observable behaviour** of ONE capability for a verification
model. You produce the capability record defined in the shared schema
(`../coverage-intelligence/references/verification-model.md`). You do NOT write tests and do
NOT document internal code structure.

## Inputs (filled by the orchestrator)
- **Capability**: `{{slug}}` — {{name}}
- **Files**: {{source_paths}}
- **Domain doc** (if any): `docs/domain/{{slug}}.md` — read it; reuse its workflows/entry points/invariants, don't re-derive.
- **Routes/schema**: {{route_files_or_openapi}}
- **Existing tests touching this capability**: {{tests}}
- **Running app**: {{up_or_down}} — if up, client `{{client_url}}`, server `{{server_url}}`.
- **Risk seed** (code-metrics): {{churn_blast_radius}}

## What "observable behaviour" means
Assertable by an actor OUTSIDE the process: an API status/body, a UI state change, a file or
git diff, an exit code, an emitted/streamed event, a DB-visible effect surfaced through an
endpoint. If the only way to "see" it is reading internal variables, it is NOT a behaviour
here — skip it.

## Method (use every source you were given; degrade gracefully)
1. **Read** the capability's domain doc + key code (entry points and logic-bearing files
   first) + route/schema definitions. Infer the *meaning*, not the control flow.
2. **Enumerate entry points** — every external trigger: API route, UI control, MCP tool, CLI
   command, webhook, scheduled job. Record what each one is *observed to do*.
3. **Enumerate actors** — who/what can drive each entry point (human role, automation/monitor,
   agent subprocess, external caller). If the system has no roles, say so; don't invent RBAC.
4. **Explore the running app** (if up): drive each UI entry point with `playwright-cli`; call
   each API entry point directly. Watch the real outcome. Note error states you can trigger
   (invalid input, busy/conflict, missing precondition). Construct behaviours from what you
   SEE, then confirm against code.
5. **Extract the state model** if one exists (lifecycle/status graph). Each transition is a
   behaviour with a trigger and an observable post-state.
6. **Mine error states** — the failure modes worth asserting (validation, 409/conflict,
   timeout, permission denied). These are usually the least-covered and highest-value.
7. **Cross-check** docs vs code vs running app. Every disagreement → an `unknowns` entry or a
   contradiction flag (documented-but-missing / implemented-but-undocumented).

## Output — return ONLY this JSON (the capability record)
Conform exactly to the `capabilities[]` element in the shared schema. For every behaviour:
- stable `id` = `{{slug}}.<verb>.<object>` (e.g. `workspaces.create.launch`)
- a one-line `statement` of the *meaning* (inferred, not paraphrased)
- `actor`, `preconditions`, `observable_outcome`, `evidence` (`file:line`)
- `dimensions` it belongs to (workflow/api/error/permission/state-transition/navigation/boundary/...)
- honest `risk` (seed from blast radius/churn) and `confidence`

### Confidence discipline
- `high` — observed in the running app AND confirmed in code.
- `medium` — clear from code + docs but not exercised live.
- `low` — inferred from code alone with weak/indirect evidence. ⇒ also add an `unknowns` entry.

### Unknowns are required output
List everything you could not determine (a flag you couldn't toggle, a role you couldn't
assume, a branch you couldn't reach). Each: `{ question, why_unknown }`. **Never** fill a gap
with a guess dressed as fact.

Keep it dense. Behaviours are atomic and assertable — aim for the real surface of the
capability, not an exhaustive list of every code path.
