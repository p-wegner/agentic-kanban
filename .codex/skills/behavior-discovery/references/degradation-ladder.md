# Graceful degradation ladder

The model must be buildable on ANY system, from a fully-documented one to a bare repo with no
docs and a dead server. Pick the highest rung whose source is actually present per capability;
record what you used in `evidence_sources` and reflect missing sources as lower `confidence` —
never as silent confidence.

| Rung | Sources present | Strategy | Confidence ceiling |
|------|-----------------|----------|--------------------|
| **5 — Full** | docs + schema + running app + tests + history | Cross-check all; behaviours observed live and confirmed in code; contradictions become findings | `high` |
| **4 — Documented** | docs/PRD/ADRs + code (server may be down) | Bind to docs, confirm in code; mark untested-live behaviours `medium` | `medium`→`high` if also confirmable by reading tests |
| **3 — Specced** | OpenAPI/GraphQL or clear route files + code | Entry points + contracts from schema; behaviours from handlers; actors from auth middleware | `medium` |
| **2 — Code-only** | source tree only, no docs, no schema | Infer capabilities from routing + directory + code-metrics clusters; behaviours from public handlers; **everything inferred ⇒ many `unknowns`** | `low`→`medium` |
| **1 — Black-box** | running app only, source unavailable/opaque | Pure exploration (`ui-explorer`/`playwright-cli` + probing the API); behaviours from observed I/O; no `file:line` evidence — mark `evidence: observed-only` | `low` |

## Rules of the ladder
- **Compare across rungs when you can.** Rung 5 isn't just "more sources" — its value is the
  *contradictions* between them. Documented-but-absent and implemented-but-undocumented
  behaviours are the highest-value output and only appear when ≥2 sources disagree.
- **Degrade per capability, not per repo.** A repo can be rung-5 for its documented core and
  rung-2 for an undocumented corner. Set `confidence` and `evidence_sources` per behaviour.
- **A dead server drops you one rung, not off the ladder.** Without live exploration you lose
  observed-truth confirmation; you keep docs+code+schema+tests. Note it; don't block on it. If
  bringing the server up is cheap (the `dev-server` skill), do it — live observation is the
  single biggest confidence multiplier.
- **Never launder inference into observation.** Code-only inference is `confidence: low` + an
  `unknowns` entry, even when the code "obviously" does the thing. The whole point of the model
  is that a downstream test author can trust the `high`-confidence behaviours and knows to
  verify the `low` ones first.
- **No source ⇒ named unknown, not omission.** If a capability has a behaviour you suspect but
  cannot evidence at any rung, record it as an `unknowns` question. A model that says "I could
  not determine whether X" is correct; one that silently omits X is wrong.
