# LoopX — Competitor Profile

**Repository**: [github.com/huangruiteng/loopx](https://github.com/huangruiteng/loopx)
**License**: Apache-2.0 (DCO, no CLA)
**Last analyzed**: 2026-09-01 (shallow clone, `C:/andrena/trending-clones/loopx`)
**Evidence level**: read at code level. Full claim-by-claim analysis:
`C:/andrena/github_trending/docs/evaluations/huangruiteng__loopx.md`

## What It Is

Not a board. A **harness-neutral control plane** that runs *on top of* an existing
coding agent instead of replacing it. The harness (Codex, Claude Code, opencode, …)
executes one bounded turn; LoopX owns the durable state around it — objectives,
gates, todos, evidence, quota, handoffs — in local files, so long-horizon work is
restartable, reviewable, and can be handed to a different harness.

It is the same problem Agentic Kanban solves, approached from the opposite end: we
start from a **board with worktrees** and add agent execution; LoopX starts from
**loop state and gates** and adds surfaces on top.

## Architecture

| Aspect | Detail |
|--------|--------|
| Runtime | Python 3.11+, **zero runtime dependencies** (`pyproject.toml:14 dependencies = []`) |
| Second runtime | A parallel TypeScript control plane (`goal-bridge-runtime.mjs` and friends) |
| Storage | Markdown + JSON on disk under the project, file-locked, versioned schemas |
| Durability | Event-sourced state, backup, compaction, index rebuild, one real rename migration |
| UI | React dashboard under `apps/presentation/dashboard/` |
| Size | ~134k lines of Python across 2,213 files (the README says "lightweight state kernel") |
| CI | pytest + `node --test` + ruff + `mypy --strict` on every PR |

## The one mechanism worth the whole read

`loopx/claude_goal_mode/hooks/goal_policy.py` — a Claude Code **`PreToolUse` hook**:

- denies non-read-only tools when the control plane says `should_run=false` (`:179-181`)
- denies `Edit`/`Write` outside the declared `write_scope` (`:188-192`)
- is **fail-closed** when the control plane is unreachable (`:182-184`)

Read-only tools are always allowed, so a paused agent can still explain itself. About
320 lines including its state helper. **This gates at turn-start; Agentic Kanban gates
at merge.** A worktree confines *where* an agent may write. This confines *when* it may
act, and it holds whether or not the model cooperates.

## Where the "governed" claim stops

Enforcement exists in exactly two shapes:

1. the opt-in Claude Code hook above (`install.py --harden`, **never installed by
   default**, Claude-Code-only, and its own docstring says it is "not strong isolation");
2. structural, where LoopX *owns the loop driver* — opencode, opencode2, pi, dsh,
   kunluncode (e.g. `goal-bridge-runtime.mjs:271-285`).

**Everywhere else — Codex, Cursor, ZCode, agy, "your own runner" — the gate is a
managed markdown skill file asking the model to call `should-run`.** The README concedes
this for agy: *"advisory pacing, not a host-enforced gate"* (`README.md:302`).

Provider neutrality is thinner than advertised: `loopx/agy_goal_mode/` and
`loopx/zcode_goal_mode/` contain **only a README and an empty `__init__.py`**. Codex
"support" is a table of display strings (`loopx/host_loop_activation.py:86-180`);
Cursor gets an MCP-config writer.

## Core Features

### Loop state
- Objectives with gates; todos; evidence attached to a goal; quota and spend budgets
- `should-run` as a queryable decision: run now / back off N minutes / stop
- Recovery and resume of an interrupted turn; handoff across harnesses
- `blocks_agent` on a todo — a stored, concrete question that mechanically flips lane
  eligibility (`should_run_prepare.py:477-482`) and unpauses on answer
  (`todos/user_gate.py:109, 194`)

### Quota / pacing
- Slot accounting and spend commit (`loopx/control_plane/quota/`)
- `unchanged_poll` backoff for loops that are not making progress

### Governance transparency
- `loopx/visible_governance.py` renders a **"RFC proposal vs shipped truth" table** —
  2 of 7 shipped, in the shipped code, by the author

## Strengths

1. **Turn-start enforcement** — the only competitor with a real, fail-closed policy hook
2. **Harness-neutral state** — the record is markdown/JSON that no harness owns
3. **Deterministic, no-LLM decision core** — gates are code, not a model call
4. **Zero runtime deps, versioned schemas, locking, migration, compaction** — real
   durability engineering, and CI actually runs the type and lint gates

## Weaknesses

1. **"Governed" is partial** — one opt-in hook for one harness; elsewhere it is a
   prompt asking the model to behave
2. **Two harness bindings are empty directories**; two more are config writers
3. **"Lightweight state kernel" is refuted** — 134k lines, plus a second runtime in TS
4. **Disclosed correctness hazard** — two claim stores (markdown soft claims + file
   leases) with no shared revision counter, "kept by design"
   (`visible_governance.py:41-52, 150-152`)
5. **CI coverage floor is `--cov-fail-under=19.6`**; the 345-script smoke suite where
   the hook gate is actually tested is "intentionally not a PR-required check"
6. **No board, no diff review, no worktree isolation** — the entire visual and review
   surface we have, it does not
7. Single author; 1,735 stars/month over 3.1 months is promotion-shaped, not adoption

## What To Steal

| Idea | Why | Effort |
|---|---|---|
| **Fail-closed `PreToolUse` gate** on top of worktree isolation — board answers "may this card spend a turn now?", hook denies non-read-only tools when no **and when the board is unreachable** | Gates at turn-start instead of only at merge; works whether or not the model cooperates | Low (~320 lines equivalent) |
| **Per-card spend budget + scheduler hint** ("run / back off N min / stop") | Attacks the failure a worktree board is blind to: a card burning turns without transitioning | Medium |
| **`blocks_agent` + a stored gate *question*** instead of a "needs review" status | Turns a soft convention into machine-checkable state that unpauses on answer | Low (card-schema addition) |
| **A shipped "proposal vs shipped truth" table** (practice, not code) | A queryable artefact of the gap between `docs/decisions/` and the implementation | Low |

## Verdict

**Study.** Take the ideas, not the 134k lines. The `PreToolUse` gate is the single
best idea any competitor in this space has had, and it composes with worktrees rather
than competing with them.
