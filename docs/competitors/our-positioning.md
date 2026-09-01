# Our Positioning — Agentic Kanban vs Competitors

Last updated: 2026-05-23

Synthesis of where Agentic Kanban differentiates and gaps to consider filling.

## Our Unique Strengths

These are things no competitor currently does (or does as well):

1. **Testability-first architecture** — 101+ E2E Playwright tests + Vitest unit tests + mock Claude profile. No competitor has a visible testing story.
2. **Parsed agent output** — Deep understanding of Claude's stream-json format (thinking blocks, tool use, subagents, task progress). Others show raw terminals.
3. **Inline diff comments** — CRUD per file+line. Cline has multi-line comments; others don't.
4. **Chat-like agent interaction** — Persistent input, Send/Stop toggle, multi-turn via --resume. Others use terminal-style input.
5. **CLI** — Full command-line interface (register, issue, workspace, skill, status, preferences). No competitor has this.
6. **Session summary (no LLM)** — Pure server-side JSONL parsing for structured summaries. No API cost.
7. **Worktree port strategy** — Deterministic ports per branch for parallel agent execution.
8. **Command palette** — Ctrl+K quick actions. No competitor has this.
9. **Agent skills system** — Built-in + custom skills, SKILL.md injection, export to Claude Code format, install from Settings UI.
10. **Windows support** — Only Cline Kanban also runs on Windows; Lanes is macOS-only.
11. **Estimate field** — XS/S/M/L/XL sizing on issues. No competitor has this.
12. **All Workspaces panel** — Aggregate view of every active workspace across all issues. Unique to us.
13. **Quick tasks panel** — Launch an agent directly from a skill without creating an issue first.
14. **Create project from UI** — New project dialog (git init or local path) without requiring CLI. Lanes also has this; others don't.
15. **Issue dependency types** — 6 typed relationships (depends_on, blocked_by, related_to, duplicates, parent_of, child_of) with color-coded badges and cycle detection. No competitor has typed deps.
16. **Scheduled runs** — Cron-based recurring agent sessions. No competitor has this.
17. **Ready-for-merge badge** — Visual indicator on workspace row when branch has no conflicts. No competitor has this.
18. **Hover quick-start actions** — Action row appears on IssueCard hover for one-click workspace start or issue move. No competitor has this.

## Where Competitors Lead

### From Cline Kanban (highest-priority gaps)

1. **Multi-agent support** — 7+ agents (Cline, Claude Code, Codex, Gemini CLI, etc.). We're Claude Code only by design, but supporting 2-3 more would be valuable.
2. **Dependency auto-chain** — Task A completes → auto-starts Task B. We have dependency *types* but not automatic chaining. **Remaining gap.**
3. **Auto-commit / auto-PR** — Ship work automatically when agent finishes. We have auto-merge but not PR creation.
4. **Symlinked node_modules** — Zero-install worktree setup. Our setup scripts solve this differently but slower.
5. **Script shortcuts** — Per-project command shortcuts in UI. Quick-access to common commands.
6. **MCP OAuth** — Browser-based auth flow for MCP servers. Enables third-party integrations.

### From Lanes (polish gaps)

1. **Process manager** — System-wide CLI discovery and kill. Useful for managing rogue agents.
2. **File browser + Monaco editor** — In-app code editing. Heavy lift but high value.
3. **Multi-select + bulk ops** — Shift/Cmd+Click for mass status changes.
4. **Linear / GitHub integration** — OAuth bridges for two-way sync. Lower priority for personal use.
5. **Session stats via MCP** — Tokens, cost, tool calls, duration exposed to agents.

### From Vibe Kanban (already skipped or not applicable)

- **Multi-tenant, cloud deployment, OAuth, billing** — out of scope by design.
- **10+ agent executors** — Claude Code only by design.
- **Integrated browser with DevTools** — nice-to-have but heavy; no plans.
- **GitHub PR creation with AI descriptions** — could be added; low priority for personal use.
- **Relay/WebRTC tunnel** — not needed for local-first.

## Priority Gaps to Fill

Ranked by effort vs. impact:

| Gap | Source | Impact | Effort | Priority |
|-----|--------|--------|--------|----------|
| Dependency auto-chain (A done → start B) | Cline | High | Medium | **P1** |
| Multi-select + bulk ops | Lanes | Medium | Low | **P2** |
| GitHub PR creation on completion | Cline/Vibe | Medium | Low | **P3** |
| Script shortcuts in UI | Cline | Low | Low | **P4** |
| Session stats via MCP | Lanes | Medium | Medium | **P5** |
| Additional agents (Codex, etc.) | Cline | High | High | **P6** (architectural) |
| File browser + editor | Lanes | High | Very High | **P7** (major feature) |
| MCP OAuth + dynamic discovery | Cline | Medium | High | **P8** |
| Integrated browser + DevTools | Vibe | Medium | Very High | **P9** (major feature) |
| Linear/GitHub integration | Lanes | Low (personal use) | Very High | **Won't do** |

## Positioning Statement

> Agentic Kanban is the **developer-first** kanban for AI coding tasks — testable, scriptable, and transparent. Where Vibe Kanban over-engineered for multi-tenant cloud, Cline optimizes for autonomous workflows, and Lanes for polished UX, we optimize for **observability and control**: every agent action is parsed, persisted, and reviewable. The 101+ E2E test suite, mock Claude profile, and full CLI make it the only option where you can confidently iterate on agent behavior with automated feedback loops.

---

# Addendum — 2026-09-01: three adjacent tools

Added [nodeterm](nodeterm.md), [LoopX](loopx.md) and [Apache Maka](maka.md). Only
LoopX was read at code level; the other two are public-material profiles.

## What changes in the analysis

**A third axis appeared.** The original comparison ranked everyone on board features
and agent breadth. These three compete on *control*:

- **LoopX gates at turn-start.** A fail-closed `PreToolUse` hook denies non-read-only
  tools when the control plane says the card may not spend a turn — and denies them
  when the control plane is *unreachable*. We gate at merge. Worktrees confine where
  an agent writes; nothing today confines when it acts.
- **Maka makes the execution record authoritative**, with the UI a view of it, and
  compacts context without deleting the evidence.
- **nodeterm makes a blocked agent visible** — hook-driven NEEDS YOU state, a
  per-node context meter, OS and phone notifications.

All three attack the same blind spot: a board shows a card as "in progress" while the
agent behind it is stalled, waiting, or burning turns. Status is not control.

## Revised gap list

| Gap | Source | Impact | Effort | Priority |
|---|---|---|---|---|
| Turn-start gate: fail-closed `PreToolUse` hook driven by card state | LoopX | **High** | Low | **P1** (new) |
| "Needs you" / blocked-on-human as a distinct card state + notification | nodeterm | High | Low | **P1** (new) |
| Per-card context meter on the card | nodeterm | Medium | Low | **P2** (new) |
| Per-card spend budget + scheduler hint (run / back off / stop) | LoopX | Medium | Medium | **P4** (new) |
| Permission decisions written into the session record | Maka | Medium | Low | **P4** (new) |
| Context compaction that preserves the evidence | Maka | Medium | Medium | **P5** (new) |
| GitHub Issues ↔ column two-way sync with label mapping | nodeterm | Medium | Medium | reopens the "Won't do" line on GitHub integration |

The earlier P1 (dependency auto-chain) and the rest of the 2026-05-23 table still
stand; these are additions, not replacements.

## Positioning, restated

The 2026-05-23 statement — *observability and control* — was half-delivered. We have
the observability: parsed stream, session summaries, inline diff comments, 101+ E2E
tests. **The control half is currently a merge gate and nothing else.** The turn-start
gate and a distinct blocked state are what would make the second word true, and both
are small.

## Not adopted, with reasons

- **nodeterm's canvas** — a genuinely different interaction model, and out of scope. A
  board is the point.
- **LoopX's harness-neutral state kernel** — 134k lines to be independent of a harness
  we deliberately picked. Claude-Code-only remains a design decision, not a gap.
- **Maka's eval harness** — the right idea, but the mock Claude profile plus the E2E
  suite covers the need until cards are scored rather than merged.
- **Anything from nodeterm's implementation** — BUSL-1.1. Design ideas only.
