# The Verification Model — shared intermediate schema

This is the **single shared data model** the three cooperating skills read and write.
It lives in the target repo under `docs/verification/`. Each skill owns part of it; none
recreates another's part. Running any skill repeatedly **updates** these files, never
rewrites them from scratch — every record carries provenance so a re-run can tell what is
stale (`analyzed_sha` changed) from what is new.

```
docs/verification/
  _behavior-model.json     # OWNED BY behavior-discovery — the observable-behaviour model
  _behavior-model.md       # human-readable render of the same (optional, generated)
  _coverage.json           # OWNED BY coverage-intelligence — the multidimensional coverage matrix
  _coverage-matrix.md      # human render: capability × dimension grid
  _gaps.md                 # human render: covered / partial / uncovered / undocumented-impl / documented-missing
  _priorities.md           # human render: ROI-ranked gap backlog (the test author's work-list)
  _testplan.md             # LIVING test plan (planner output): one scenario per behaviour, [x]/[~]/[ ] derived from coverage
  _candidates.json         # OWNED BY coverage-intelligence (tools/candidates.mjs) — per-capability candidate test sets
  capabilities/<slug>.json # fan-out unit: one file per capability with { behavior, coverage } — assembled into the two JSONs above
  _test-index.json         # OWNED BY coverage-intelligence (tools/test-inventory.mjs) — deterministic existing-test inventory
  _authored.json           # OWNED BY e2e-test-author — what was generated, which gaps it closed, review verdicts
  _verification-log.md     # shared ledger: per-run strategy + findings + dispositions (dedup anchor across re-runs)
  <capability-slug>.md     # per-capability verification spec (behaviours + test matrix + coverage + gaps)
```

The two JSON files are the contract. The `.md` files are renders for humans and for the
next skill's subagents to read cheaply.

---

## `_behavior-model.json` — owned by `behavior-discovery`

The **observable-behaviour** model: what the system does that an outside actor can see and
assert on. Inferred (per the domain-docs "infer, don't paraphrase" bar), not transcribed.
Bound to the domain-docs capability spine (`docs/domain/_plan.json`) by `capability` slug
when those docs exist; stands alone (degraded mode) when they don't.

```jsonc
{
  "schema": "verification-model/behavior@1",
  "analyzed_sha": "<HEAD at discovery time>",
  "evidence_sources": ["domain-docs", "openapi", "ui-exploration", "source", "tests", "git"], // which were actually available
  "capabilities": [
    {
      "slug": "workspaces",                       // matches docs/domain/_plan.json slug when present
      "name": "Workspaces & Worktrees",
      "business_purpose": "<inferred meaning, not a code summary>",
      "confidence": "high|medium|low",            // lower it when degraded (no docs, inferred from code only)
      "source_paths": ["packages/server/src/services/workspace-create.service.ts"],
      "actors": [                                  // who can drive this capability
        { "name": "operator", "kind": "human", "notes": "single local user" },
        { "name": "monitor", "kind": "automation", "notes": "in-process auto-start" }
      ],
      "entry_points": [                            // every externally reachable trigger
        { "kind": "api", "ref": "POST /api/workspaces", "observable": "creates worktree + launches agent" },
        { "kind": "ui", "ref": "New Workspace button (IssueDetailPanel)", "observable": "..." },
        { "kind": "mcp", "ref": "create_issue", "observable": "..." },
        { "kind": "cli", "ref": "pnpm cli -- workspace resume <N>", "observable": "..." }
      ],
      "behaviors": [                               // the atomic, assertable units — the rows of the coverage matrix
        {
          "id": "ws.create.launch",               // stable id: <cap>.<verb>.<object>
          "statement": "Creating a workspace provisions an isolated worktree and auto-launches the agent",
          "actor": "operator",
          "preconditions": ["issue exists", "repo registered"],
          "observable_outcome": "workspace row appears; session starts; diff endpoint becomes reachable",
          "evidence": ["workspace-create.service.ts:42"],
          "dimensions": ["workflow", "capability", "api"],   // which coverage dimensions this behaviour belongs to
          "risk": "high|medium|low",              // blast radius if it breaks (seed from code-metrics)
          "confidence": "high|medium|low"
        }
      ],
      "permissions": [                             // role/permission matrix when the system has one
        { "actor": "operator", "behavior": "ws.create.launch", "allowed": true }
      ],
      "state_model": {                             // testable state machine when one exists
        "states": ["created", "running", "idle", "in-review", "merged", "discarded"],
        "transitions": [
          { "from": "running", "to": "idle", "trigger": "agent exits", "behavior": "ws.lifecycle.idle" }
        ]
      },
      "error_states": [                            // observable failure modes worth asserting
        { "id": "ws.create.busy", "statement": "follow-up turn on a busy ws returns 409", "evidence": "..." }
      ],
      "external_integrations": ["git CLI", "agent subprocess"],
      "unknowns": [                                // EXPLICIT — never guessed. drives further exploration
        { "question": "is plan-mode gate reachable from the UI?", "why_unknown": "not observed in exploration" }
      ]
    }
  ]
}
```

**Rules for this file**
- A behaviour is **observable** — assertable by an actor outside the process (API response,
  UI state, file/diff, exit code, emitted event). "Calls `insertRow`" is not a behaviour.
- `unknowns` are first-class. Mark what you could not determine; do **not** invent it.
- `risk`/`confidence` are honest estimates, seeded from code-metrics (blast radius, churn)
  and from how the behaviour was learned (observed > docs > inferred-from-code-only).

---

## `_coverage.json` — owned by `coverage-intelligence`

Binds behaviours × requirements × existing tests × history into the coverage matrix.

```jsonc
{
  "schema": "verification-model/coverage@1",
  "analyzed_sha": "<HEAD>",
  "dimensions": ["capability","requirement","workflow","permission","navigation","api",
                 "error","boundary","state-transition","config","accessibility","regression","risk"],
  "behaviors": [
    {
      "ref": "ws.create.launch",
      "status": "covered|partial|uncovered|undocumented-implemented|documented-missing",
      "covered_by": [                              // existing tests that exercise this behaviour
        { "test": "packages/e2e/tests/ui/workspace-create.test.ts::creates and launches", "strength": "asserts-outcome|touches-only" }
      ],
      "requirements": ["PRD-04:auto-launch", "ADR-..."],   // requirements this behaviour realises
      "dimensions_covered": ["workflow","api"],     // dims actually asserted by covered_by tests
      "dimensions_missing": ["error","permission"], // dims the behaviour has but no test asserts
      "history": { "churn_90d": 14, "bugs": 2, "last_regression": "..." }, // regression signal
      "gap": {                                      // present iff status != covered
        "kind": "no-test|outcome-not-asserted|dimension-missing|undocumented|missing-impl",
        "missing_dimensions": ["error","permission"],
        "rationale": "create path tested; 409-on-busy and permission denial never asserted"
      }
    }
  ],
  "requirements": [                                 // requirement-side view (the reverse index)
    { "id": "PRD-04:auto-launch", "source": "docs/prd/04-agent-integration.md",
      "status": "covered|partial|uncovered", "behaviors": ["ws.create.launch"], "tests": ["..."] }
  ],
  "summary": {
    "by_dimension": { "workflow": {"covered": 12, "partial": 5, "uncovered": 3}, "...": {} },
    "by_capability": { "workspaces": {"score": 0.62, "uncovered_high_risk": 2 } }
  }
}
```

The five statuses (the gap taxonomy the design asks for):
- **covered** — a test asserts the behaviour's outcome across its risk-relevant dimensions.
- **partial** — a test touches it but doesn't assert the outcome, or covers some dimensions not others.
- **uncovered** — behaviour exists, no test exercises it.
- **undocumented-implemented** — behaviour observed in code/UI but absent from requirements/docs (`?` in the design).
- **documented-missing** — a requirement/doc describes behaviour the code does not implement (`?` in the design — verify before asserting; this is a real finding, escalate it).

---

## `_priorities.md` — owned by `coverage-intelligence`, consumed by `e2e-test-author`

ROI-ranked backlog. Each row is a self-contained spec the author skill can build from
without re-deriving context. See `prioritization.md` for the scoring model. Shape:

| rank | behavior id | priority | ROI | business impact | regression value | exec cost | maint cost | dimensions to add | rationale |
|------|-------------|----------|-----|-----------------|------------------|-----------|------------|-------------------|-----------|

Plus, per row, a **gap spec block** (capability, actor, preconditions, observable outcome,
entry point, suggested assertions) so the author subagent gets everything in one place.

---

## `_authored.json` — owned by `e2e-test-author`

```jsonc
{
  "schema": "verification-model/authored@1",
  "runs": [
    { "sha": "...", "gap": "ws.create.busy", "test_file": "packages/e2e/tests/ui/workspace-busy.test.ts",
      "declares_dimensions": ["error","api"], "review_verdict": "sound|needs-fix|unsound",
      "review_findings": ["..."], "status_after": "covered" }
  ]
}
```

After authoring, the author skill **writes the new test back into `_coverage.json`** (flips
the behaviour's status, appends to `covered_by`). That is what makes re-running the whole
pipeline *improve* the model instead of recreating it.
