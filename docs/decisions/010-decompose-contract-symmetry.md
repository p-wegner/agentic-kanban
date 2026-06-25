# 010 — Decompose ↔ Contract symmetry (coupling lifecycle)

## Context

The coupling epic added `coupled_with` as a first-class dependency edge (#916), detection
of coupling from predicted-touched-file overlap (#917), and — this ticket (#918) — the
**agentic** half: capturing coupling at ticket-creation time and letting the monitor act on
it. That raised the question of how a *set of coupled tickets* gets turned back into one
buildable unit, and where that operation should live.

## Decision

**Contract is the documented INVERSE of decompose, and lives next to it in
`issue-ai.service.ts`.** They are a forward/inverse pair over the same dependency graph:

| | Decompose (forward) | Contract (inverse) |
|---|---|---|
| Input | one epic ticket | a coupled component (≥2 `coupled_with` peers) |
| Output | a tree of child tickets | one merged survivor ticket |
| Edges written | `parent_of` / `child_of` (+ child `depends_on`) | drops the internal `coupled_with` edges |
| Graph shape | tree (directed) | connected component (undirected, symmetric) |
| Propose fn | `decomposeEpic` | `contractCoupledComponent` |
| Confirm fn | `confirmEpicDecomposition` | `confirmContractComponent` |
| Members' fate | created fresh in Backlog | survivor kept (lowest #), rest Cancelled w/ pointer |

Both follow the **propose → confirm** pattern: the propose function reads the board and
returns a non-mutating proposal (an LLM merges the members' bodies, with a deterministic
concatenation fallback); the confirm function applies it in one pass.

### Discovery reuses the existing primitives end-to-end

- Coupling is **declared at creation** through the SAME `dependencies` payload the analyzer
  already writes: `create_issues_batch` (MCP + REST) accepts `coupled_with` edges by index,
  committed in the issues' transaction. No new mechanism — a generating agent (backlog-refill,
  epic decomposition, butler authoring) emits the edge alongside the tickets.
- Coupled **components** are built by `couplingComponents()` (pure, in `shared/lib/coupling-overlap.ts`)
  over the `coupled_with` edges (`getCoupledEdges`). This is the undirected-graph view that
  mirrors the directed `parent_of`/`child_of` tree decompose produces.
- The monitor's gated auto-contract step (`runAutoContract`, `monitor-contract.ts`) calls
  `contractCoupledComponent` to discover+propose and `confirmContractComponent` to apply.

### Gating — mirrors the existing auto-* prefs, off by default

The step is gated per project on `auto_contract_coupled_<projectId>` (a project-scoped
dynamic key, like `auto_merge_disabled_<id>` / `start_mode_<id>`):

- `"apply"` — auto-contract every eligible component before fan-out.
- `"suggest"` / `"true"` — log a suggestion per component; change nothing.
- absent / `""` / `"false"` — disabled (**default**).

It runs in `runMonitorCycle` immediately **before** `runAutoStart`, and only for projects the
monitor would otherwise auto-start work for — so coupled tickets are contracted (or flagged)
*before* they could fan out into separate conflicting workspaces. Minimum component size is the
global `coupling_contract_min_size` (default 2). A component with any open workspace is never
absorbed (don't kill in-flight work) — the contract is deferred to a later cycle.

## Consequences

- The coupling lifecycle is closed: declare at birth → detect/declare via the analyzer →
  contract (inverse of decompose) when the monitor would otherwise fan out.
- Contract is reachable three ways through one implementation: REST (`POST /api/issues/contract`
  + `/contract/confirm`), the monitor step, and (future) a UI affordance — all calling the
  same service functions, the way decompose already is.
- Survivor-keeps-its-number means coupling contraction preserves ticket history and inbound
  references; absorbed tickets are Cancelled (not deleted) with a pointer back, so the audit
  trail survives.
