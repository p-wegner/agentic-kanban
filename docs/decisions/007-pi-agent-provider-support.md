# Decision 007: Pi Agent Provider Support

## Date: 2026-06-08

## Status

**Active** — design approved in #722. Implementation tracked as child tickets
#724–#730 on the board. Phases must run in order: #724 (CLI verification) unblocks
all others. No code yet; this document is the contract a Builder follows.

## Context

The board can already run three agent harnesses behind a single
`AgentProvider` abstraction: **Claude Code**, **Codex**, and **Copilot**. "PI" is
**Pi**, the open-source coding-agent harness by Mario Zechner
([earendil-works/pi](https://github.com/earendil-works/pi),
npm `@mariozechner/pi-coding-agent`, docs <https://pi.dev/>). Pi is a deliberate
fit for this board because it is built around exactly the three extension
mechanisms #720 names — **hooks, subagents, and skills** (plus prompt templates,
themes, and shareable npm/git packages) on top of a small core, with a
multi-provider LLM backend (Claude, GPT-5, Gemini, Grok, DeepSeek, Llama).

Adding Pi is **purely additive** (per the #720 clarifications): Claude / Codex /
Copilot are untouched, existing projects keep their current provider, and Pi
appears as a new fourth option in Settings → Agent. There is no migration.

### Why this is mostly a "fill in the seams" job, not new architecture

The provider contract is already abstracted. `AgentProvider`
(`packages/server/src/services/agent-provider/types.ts`) requires only two methods:

```ts
buildLaunchConfig(options: ProviderLaunchOptions): AgentLaunchConfig
parseStreamEvent(line: string): ParsedStreamEvent | undefined
```

Providers register in `registry.ts`; `buildAgentLaunchConfig()` dispatches by name.
`ProviderName` / `ProviderId` are string unions; selection flows from the Strategy
Bullseye → `selectProviderFromStrategy` → `resolveAgentSettings`; output is parsed
by a per-provider client parser (`createAgentOutputParser`). Codex was added by
walking exactly these seams (`docs/codex-agent-support.md`) — Pi follows the same
path. The novel work is in the **extension surface** (hooks/subagents/skills), not
the launch plumbing.

### Pi's invocation surface (from upstream docs, to verify against the installed CLI)

- **Non-interactive output:** `pi -p` (print-and-exit), `--mode json` (events as
  JSON lines — the one to use), `--mode rpc` (stdin/stdout RPC). Also an embeddable
  SDK.
- **Model / provider:** `--provider <anthropic|openai|google|…>`, `--model <id>`
  (supports `provider/id` and `:thinking`), `--api-key <key>`,
  `--thinking <off|low|…|xhigh>`.
- **Sessions / resume:** `-c/--continue`, `-r/--resume`, `--session <path|id>`,
  `--fork`, `--session-dir <dir>`, `--no-session`. Session storage:
  `~/.pi/agent/sessions/`. ID surfaced via the `/session` command — **the exact
  field/event that carries the session id in `--mode json` must be captured from a
  real run before wiring resume** (same caution Codex had).
- **Trust / headless:** non-interactive modes show **no** trust prompt and
  **ignore project-local inputs (incl. `.pi/` extensions, skills, hooks) unless
  `-a/--approve` is passed**. This is the single most important headless gotcha (see
  Consequences). Trust DB: `~/.pi/agent/trust.json`.
- **Working dir:** not an explicit flag in the docs — spawn with `cwd` set to the
  worktree (we already do this for every provider) and verify.
- **Extensions:** `-e/--extension <path|npm|git>`, `--skill <path>`,
  `--prompt-template <path>`, `--theme <path>` (all repeatable); `--no-extensions`,
  `--no-skills`, etc. to disable discovery. `pi install/remove/update/list` manage
  packages; project-local packages live in `.pi/`, global in `~/.pi/agent/`.
- **Context files:** auto-discovers `~/.pi/agent/AGENTS.md` (global) and
  project `AGENTS.md` **or `CLAUDE.md`** (when trusted). System prompt override:
  `.pi/SYSTEM.md` / `~/.pi/agent/SYSTEM.md`, append via `APPEND_SYSTEM.md`.
- **Config override env:** `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
  `PI_PACKAGE_DIR` — the analog of `CODEX_HOME`, usable for per-profile isolation.
- **MCP:** not documented in the excerpt read; **open question** — confirm whether
  Pi consumes an MCP config and in what shape before wiring the board MCP server.

## Decision

Add Pi as a **fourth `AgentProvider`** (`provider = "pi"`,
`providerId = "pi"`), launched as a **CLI subprocess in `--mode json`**, following
the existing Codex playbook. Do **not** use Pi's SDK for task agents — task agents
stay CLI subprocesses for worktree isolation and hot-reload survival (consistent
with Decision 003's split; the SDK is reserved for warm in-process assistants like
the Butler, a separate future question).

Map the three extension mechanisms onto Pi's native equivalents rather than
inventing board-specific ones:

| Mechanism | Claude today | Codex today | **Pi target** |
|---|---|---|---|
| **Skills** | `.claude/skills/<name>/SKILL.md` (written by `writeAgentSkillFile`) | `.codex/skills` **junction** → `.claude/skills` | Write the same `SKILL.md`, then **either** junction `.pi/skills` → `.claude/skills` **or** pass each via `--skill <path>`. Prefer `--skill` flags (explicit, survives the trust-gating of `.pi/`). |
| **Context file** | `CLAUDE.md` | `AGENTS.md` | Pi reads **both** `AGENTS.md` and `CLAUDE.md` natively — no new file needed; the board's builder-guardrail injection should target `AGENTS.md` (Codex parity). |
| **Hooks** | `.claude/settings.json` hooks block → `.claude/hooks/*.js` | `.codex/hooks.json` → `smart-hooks-runner.js` | A **Pi extension** (TS package under `.pi/`, or loaded via `-e`) that is a **thin adapter** re-running the same `.claude/hooks/*.js` scripts — exactly the pattern the existing `.opencode/plugin/agentic-kanban-hooks.ts` uses for OpenCode. **Do not reimplement the guard logic.** |
| **Subagents** | implicit Claude SDK `Agent` tool (prompt-driven, in `orchestrator`/`architecture-review` skills) | none | Pi has **first-class subagents** in its extension system — richer than Claude's. The orchestrator/architecture-review skills' subagent prompts should work as-is; a Pi-native subagent definition is a later enhancement, not required for v1. |
| **Prompt templates** | (skill prompts) | (skill prompts) | Optional: expose board skills as Pi `--prompt-template`s later; not in v1. |

## Phased plan (next steps)

Mirrors `docs/codex-agent-support.md`'s incremental sequence. Each phase is a
board ticket; keep Claude as default and change no existing provider's flags.

1. **#724 — Map & verify the CLI** — install Pi, capture real `--mode json` output
   for a one-shot run, a resume, and a tool call. Confirm: the JSON event schema, the
   field carrying the **session id**, the **working-dir** mechanism, **rate-limit /
   usage** event shape, and **MCP** config support. (Resolves the open questions
   below — do this before any parser code, per the Codex lesson.)
2. **#725 — Types & prefs** — add `"pi"` to `ProviderName`/`ProviderId`
   (`agent-provider/types.ts`), `ProfileSelection.provider` (`shared/types/api.ts`),
   the strategy provider literals (`strategy-objective.service.ts`), and
   `parseProviderName` (`agent-settings.service.ts`). Add `PREF_PI_PROFILE`
   (`constants/preference-keys.ts`) and whitelist it in **both** the GET `keys` and
   PUT `allowedKeys` arrays in `routes/preferences.ts`. Decide Pi's
   profile/auth model (likely `PI_CODING_AGENT_DIR` per profile, mirroring
   `CODEX_HOME`).
3. **#726 — Provider implementation** — `agent-provider/pi-provider.ts` implementing
   `buildLaunchConfig` (resolve the `pi` binary on Windows; build
   `--mode json --provider … --model … --approve` + cwd + resume + `--skill` flags)
   and `parseStreamEvent` (map Pi JSON events → `ParsedStreamEvent`: stats, tool
   activity, live model/context, rate-limit, session id). Register in `registry.ts`.
4. **#727 — Client output parser** — `packages/client/src/lib/pi-output-parser.ts` +
   `"pi-jsonl"` format in `agent-output-parser.ts`, wired through the parser factory
   by provider.
5. **#728 — Skills + hooks materialization** — extend the worktree provisioning so a
   Pi workspace gets skills via `--skill`/`.pi` and a Pi hook-adapter extension; reuse
   `.claude/hooks/*.js` unchanged. Add a `convert-hooks-to-pi` skill modeled on
   `convert-hooks-to-opencode` if the adapter is non-trivial.
6. **#729 — UI** — add a `<optgroup label="Pi">` and `piProfiles` state in
   `AgentSettings.tsx` / `SettingsPanel.tsx`, a `providerDisplayName("pi")` case, and
   Pi profile discovery (extend `/api/agent-profile-health`).
7. **#730 — Validate** — run a real ticket end-to-end on Pi through the board (launch
   → diff → review → merge), confirm hooks fire (DB-safety + cross-worktree guards)
   and the Stop checks gate, then document operational detail in
   `packages/server/CLAUDE.md` and the "Agent Providers" section of `CLAUDE.md`.

## Rationale

1. **The abstraction already exists** — Pi slots into the same two-method
   `AgentProvider` contract Codex/Copilot use; the launch plumbing is a known
   quantity (`docs/codex-agent-support.md` proved the path).
2. **Pi's extension model is the closest match to what #720 asks for** — it has
   native hooks, subagents, skills, and prompt templates, so we adapt rather than
   invent. Subagents are *better* than Claude's prompt-driven approach.
3. **Reuse the guard scripts, don't fork them** — the `.opencode` plugin already
   demonstrates a thin-adapter port of `.claude/hooks/*.js`; the same approach for
   Pi keeps one source of truth for the DB-safety / cross-worktree guards CLAUDE.md
   forbids weakening.
4. **CLI subprocess, not SDK, for task agents** — preserves worktree isolation and
   hot-reload survival; consistent with Decision 003.

## Consequences / risks

- **Trust gating is the headline risk.** In non-interactive mode Pi **ignores all
  project-local `.pi/` inputs (extensions, skills, hooks) unless `-a/--approve` is
  passed.** A Pi provider that forgets `--approve` will silently run with **no hooks
  and no skills** — the DB-safety and cross-worktree guards would not fire. The
  provider MUST pass `--approve` (and/or pre-seed `~/.pi/agent/trust.json`), and
  phase-7 validation MUST assert a guard actually blocks. This is the Pi analog of
  the "POST /api/workspaces defaults to codex" silent-misconfig class.
- **Hooks can only *soft-block* if Pi has no pre-tool veto.** Confirm in phase 1
  whether a Pi hook can abort a tool call (Claude `PreToolUse` semantics) or is
  after-the-fact only (the OpenCode `Stop` caveat). If the latter, the cross-worktree
  write guard degrades to a nudge and we lean on the existing main-checkout commit
  guards instead.
- **`default_model` cross-provider drift.** A global `default_model` is applied to
  every provider; a Pi model id handed to claude.exe (or vice-versa) breaks launches
  (the documented multi-cycle stall). Adding Pi widens this footgun — keep using the
  `set-provider-default` skill, and ensure `modelBelongsToProvider` learns Pi's model
  families.
- **Auth model is unsettled** — Pi is BYOK across many LLM providers. The profile
  abstraction (`PREF_PI_PROFILE`) must decide whether a "Pi profile" selects an LLM
  provider + key, a `PI_CODING_AGENT_DIR`, or both. Resolve in phase 2.
- Pi is added to all provider unions/branches; any future provider-listing code must
  account for four, not three.

## Open questions (carry into Consult User / phase 1)

- [ ] Exact `--mode json` event schema, and which field carries the **resume/session
  id**.
- [ ] Does Pi support **MCP**, and in what config shape? (Determines whether the
  board MCP server is reachable from Pi task agents.)
- [ ] Can a Pi **hook veto a tool call pre-execution**, or only observe after?
  (Determines whether guards are hard gates or soft nudges.)
- [ ] **Auth/profile shape** — what does a "Pi profile" select (LLM provider, key,
  `PI_CODING_AGENT_DIR`)?
- [ ] **Working-directory** mechanism in headless mode (cwd vs a flag).
- [ ] Is there a **rate-limit / usage-limit** event to map to `rateLimitInfo` (needed
  for the monitor's credit-exhaustion handling)?

## References

- Pi: <https://github.com/earendil-works/pi> · <https://pi.dev/> ·
  npm `@mariozechner/pi-coding-agent`
- Pi usage doc:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md>
- Existing precedent: `docs/codex-agent-support.md` (Codex onboarding sequence)
- Hook-port precedent: `.opencode/plugin/agentic-kanban-hooks.ts`,
  `.claude/skills/convert-hooks-to-opencode/SKILL.md`
- Provider seams: `packages/server/src/services/agent-provider/` (`types.ts`,
  `registry.ts`, `{claude,codex,copilot}-provider.ts`)
- Decision 003 (SDK-vs-CLI split) — task agents stay CLI subprocesses.
