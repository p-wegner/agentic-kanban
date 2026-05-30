# 004 — Spec-Driven, Interactive Phased Planning

**Status:** Proposed (analysis + backlog seeded 2026-05-30)
**Related:** [[003-butler-architecture-agent-sdk-vs-cli]], epic #76 (configurable workflow graphs)

## Context

Spec-driven development (SDD) tools — GitHub **Spec Kit**, **OpenSpec**, **GSD**, AWS **Kiro**, **Conductor**, **cc-sdd**, **Tessl** — have converged on a shared way of working with coding agents. We evaluated whether and how to bring SDD into agentic-kanban.

### What every SDD tool shares

- **Phase skeleton:** intent → requirements → design/plan → tasks → implement → verify.
- **Artifact quartet:** a *constitution/rules* file, a *spec* (what/why), a *plan/design* (how), a *task list*.
- **Human gates between phases** — the defining discipline (cc-sessions makes it a hard tool-block; Kiro/Spec Kit make it a review checkpoint).
- **Runtime tricks:** fresh context per task, atomic one-task-one-commit, spec-as-persistent-memory.

### Two philosophies

- **One-shot, per-feature** (Spec Kit, Kiro): `specify → plan → tasks → implement`, one `specs/<feature>/` folder per feature. Maps 1:1 onto our **issue → worktree → branch**.
- **Living specs + deltas** (OpenSpec): a persistent `openspec/specs/<domain>/spec.md` source-of-truth; each change is a delta (ADDED/MODIFIED/REMOVED) merged back on archive. This is the **persistent project context our Butler lacks today**.

## Key finding: we already own the runtime half of SDD

The standalone tools bolt the whole pipeline onto plain markdown files because they have no runtime. We do. The board already provides the parts they fake:

| SDD concept | What we already have |
|---|---|
| Phases with gates | Configurable workflow graphs — nodes=statuses, `node.skillId`, `node.config`, edge `condition`s, `propose_transition` (`workflow-engine.ts`) |
| "Plan before code" | `planMode` → `workspace.pendingPlanPath` → `implement-plan` endpoint |
| Task list → work | Sub-issues (`parent_of`/`child_of`) + `create_issues_batch` + `analyze-dependencies` |
| Phase prompts | Agent skills → `.claude/skills/<name>/SKILL.md` (OpenSpec literally ships *as* `.claude/skills/`) |
| Spec artifacts | `issueArtifacts` table (text/link/image) |
| Constitution | per-worktree `CLAUDE.md` + Scope Constraints |
| Clarify / interview | the Butler (per-project warm Agent SDK session) |

The gap is **not** runtime. It is (a) the upstream artifact pipeline (constitution → spec → design → tasks), and (b) the **interactive** planning experience.

## The steering insight: interactivity is the point

The core value of SDD is **interactive planning** — a human and an agent converging on *what to build* before any code is written, one phase at a time. Our board's instinct is the opposite: it **automates and hides** the agent's actions from the user (fire a workspace, surface a diff at the end). That is exactly right for execution and exactly wrong for planning.

So the headline of this work is **not** "run spec/plan/tasks agents headlessly." It is **a Butler-style, conversational, per-phase planning UI**: when an issue is in the *Specify* phase, the user gets a focused chat/review panel for that phase — the agent drafts the spec, asks clarifying questions, the user edits and answers inline, and the **gate to the next phase is a deliberate human action**, not an auto-transition. The Butler view is the proven UI primitive for this; the phased planning experience should reuse and extend it.

## Decision (stance)

1. **Native, not wrapped.** Implement SDD on our own workflow graph + skills + Butler. Do **not** shell out to `specify`/`openspec` CLIs — their branch/script machinery fights our worktree+merge layer, which is better and headless. Borrow their *conventions, artifacts, and gates*.
2. **Borrow from both philosophies.** Spec Kit's phase-as-status + `tasks → issues` for the per-issue workflow; OpenSpec's living-spec layer for persistent Butler/board context (later phase).
3. **Interactivity first.** The deliverable that matters is the interactive per-phase planning panel with human gates — not headless automation. Lead with it.
4. **Opt-in per issue.** A Spec Kit run produced ~2,500 lines of markdown and was ~10× slower than plain prompting for one feature. The spec-driven path must be **opt-in** (issue type or toggle); the fast path stays default. This mirrors our existing Scope Constraints instinct.
5. **Don't reinvent GSD's fresh-context-per-task.** We already get that from worktree-per-issue.

## Integration plan (seeded as backlog tickets)

1. **Spec-driven workflow graph template** — `Backlog → Specify → Design → Tasks → Implement → Review → Done`, each spec phase a node with an attached phase skill; transitions gated via `propose_transition`. (`workflows.ts`, `workflow-engine.ts`, `builtin-skills.ts`, `seed.ts`)
2. **Interactive per-phase planning UI (the centerpiece)** — a Butler-style conversational panel bound to the issue's current phase: agent drafts the phase artifact, asks clarifying questions surfaced as inline prompts, the user edits/answers and explicitly approves the gate. Reuses Butler streaming + AgentQuestionsPanel patterns.
3. **`tasks.md` → real child issues with dependency waves** — the Tasks phase calls `create_issues_batch` + `analyze-dependencies`, so independent tasks launch workspaces concurrently and dependent ones stay blocked. Real board entities, not markdown checkboxes.
4. **Specs as worktree artifacts + persistence** — phase artifacts live in the worktree (reviewed via the existing diff/merge gate) and persist to `issueArtifacts` so they survive and carry into the implement phase.
5. **Living-spec layer + Butler context (OpenSpec-style)** — an `openspec/specs/` truth folder, MCP read tools, merged on workspace-merge; gives the Butler persistent project knowledge.
6. **MCP primitives** — `create_sub_issue`, `attach_artifact`, and a clarify/propose primitive so phase skills have explicit knobs.
7. **Constitution surface** — promote per-project `CLAUDE.md` to the rules gate the Specify/Plan phases must honor.

## Risks

- **Waterfall heaviness** for small changes → opt-in per issue, keep the fast path.
- **Spec-merge conflicts** when parallel worktrees edit the same `specs/<domain>.md` — same class as our drizzle migration-number collisions. Mitigate with per-domain delta scoping + a "two open workspaces touch the same spec domain" warning (like the conflict scan).
- **Over-automation regression** — if phases auto-run without genuine human gates we rebuild the thing SDD exists to fix. Gates must be deliberate user actions.

## References

- Spec Kit: <https://github.com/github/spec-kit>, <https://github.com/github/spec-kit/blob/main/spec-driven.md>; independent critique: <https://blog.scottlogic.com/2025/11/26/putting-spec-kit-through-its-paces-radical-idea-or-reinvented-waterfall.html>
- OpenSpec: <https://github.com/Fission-AI/OpenSpec> (concepts, commands, cli docs)
- GSD: <https://github.com/open-gsd/get-shit-done-redux>
- Kiro specs: <https://kiro.dev/docs/specs/>
- Conductor: <https://developers.googleblog.com/conductor-introducing-context-driven-development-for-gemini-cli/>
- cc-sdd: <https://github.com/gotalab/cc-sdd> · cc-sessions: <https://github.com/GWUDCAP/cc-sessions> · Tessl: <https://docs.tessl.io/use/spec-driven-development-with-tessl>
- Martin Fowler, *Understanding SDD: Kiro, spec-kit, Tessl*: <https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html>
