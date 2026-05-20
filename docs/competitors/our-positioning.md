# Our Positioning — Agentic Kanban vs Competitors

Synthesis of where Agentic Kanban differentiates and gaps to consider filling.

## Our Unique Strengths

These are things no competitor currently does (or does as well):

1. **Testability-first architecture** — 135+ E2E Playwright tests + Vitest unit tests + mock agent. No competitor has a visible testing story.
2. **Parsed agent output** — Deep understanding of Claude's stream-json format (thinking blocks, tool use, subagents). Others show raw terminals.
3. **Inline diff comments** — CRUD per file+line. Cline has multi-line comments; others don't.
4. **Chat-like agent interaction** — Persistent input, Send/Stop toggle, multi-turn via --resume. Others use terminal-style input.
5. **CLI** — Full command-line interface (register, issue, workspace, skill, status). No competitor has this.
6. **Session summary (no LLM)** — Pure server-side JSONL parsing for structured summaries. No API cost.
7. **Worktree port strategy** — Deterministic ports per branch for parallel agent execution.
8. **Command palette** — Ctrl+K quick actions. No competitor has this.
9. **Agent skills system** — Built-in + custom skills, SKILL.md injection, export to Claude Code format, install from Settings UI.
10. **Windows support** — Only Cline Kanban also runs on Windows; Lanes is macOS-only.
11. **Estimate field** — XS/S/M/L/XL sizing on issues. No competitor has this.
12. **All Workspaces panel** — Aggregate view of every active workspace across all issues. Unique to us.
13. **Quick tasks panel** — Launch an agent directly from a skill without creating an issue first.
14. **Create project from UI** — New project dialog (git init or local path) without requiring CLI. Lanes also has this; others don't.

## Where Competitors Lead

### From Cline Kanban (highest-priority gaps)

1. **Multi-agent support** — 7+ agents (Cline, Claude Code, Codex, Gemini CLI, etc.). We're Claude Code only by design, but supporting 2-3 more would be valuable.
2. **Dependency chains** — Task A completes → auto-starts Task B. Enables autonomous multi-step workflows. **High-value gap.**
3. **Auto-commit / auto-PR** — Ship work automatically when agent finishes. Reduces manual merge step.
4. **Symlinked node_modules** — Zero-install worktree setup. Our setup scripts solve this differently but slower.
5. **Script shortcuts** — Per-project command shortcuts in UI. Quick-access to common commands.
6. **MCP OAuth** — Browser-based auth flow for MCP servers. Enables third-party integrations.

### From Lanes (polish gaps)

1. **Issue dependencies** — Cycle detection, blocking visual indicators. Related to Cline's dependency chains.
2. **Process manager** — System-wide CLI discovery and kill. Useful for managing rogue agents.
3. **File browser + Monaco editor** — In-app code editing. Heavy lift but high value.
4. **Multi-select + bulk ops** — Shift/Cmd+Click for mass status changes.
5. **Linear / GitHub integration** — OAuth bridges for two-way sync. Lower priority for personal use.
6. **Session stats via MCP** — Tokens, cost, tool calls, duration exposed to agents.

### From Vibe Kanban (already skipped)

- Multi-tenant, cloud deployment, 10+ agents, OAuth, billing — all out of scope by design.

## Priority Gaps to Fill

Ranked by effort vs. impact:

| Gap | Source | Impact | Effort | Priority |
|-----|--------|--------|--------|----------|
| Task dependencies + auto-chain | Cline | High | Medium | **P1** |
| Multi-select + bulk ops | Lanes | Medium | Low | **P2** |
| Auto-commit on completion | Cline | Medium | Low | **P3** |
| Script shortcuts in UI | Cline | Low | Low | **P4** |
| Session stats via MCP | Lanes | Medium | Medium | **P5** |
| Additional agents (Codex, etc.) | Cline | High | High | **P6** (architectural) |
| File browser + editor | Lanes | High | Very High | **P7** (major feature) |
| MCP OAuth + dynamic discovery | Cline | Medium | High | **P8** |
| Linear/GitHub integration | Lanes | Low (personal use) | Very High | **Won't do** |

## Positioning Statement

> Agentic Kanban is the **developer-first** kanban for AI coding tasks — testable, scriptable, and transparent. Where competitors optimize for autonomous workflows (Cline) or polished UX (Lanes), we optimize for **observability and control**: every agent action is parsed, persisted, and reviewable. The 135+ E2E test suite and mock agent make it the only option where you can confidently iterate on agent behavior with automated feedback loops.
