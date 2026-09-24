# Agent providers and profile selection

_Moved verbatim from the root `CLAUDE.md` on 2026-09-25 (token pass). CLAUDE.md keeps the rules; this page keeps the rationale, incidents and detail. Section headings are the originals._

## Agent Providers
Pi runs as `pi --mode json` with explicit `--extension <worktree>/.pi/plugin/agentic-kanban-hooks.ts` and repeated `--skill <worktree>/.claude/skills/<name>/SKILL.md` flags for the skills materialized into the workspace. Pi 0.73.1 rejects `--approve`; do not add it. Safety hooks are hard pre-tool gates via Pi's `tool_call` event, and the adapter delegates to the existing `.claude/hooks/*.js` scripts instead of reimplementing DB-safety or cross-worktree write logic.

Claude Code, Codex, Copilot — selectable via Settings → Agent. Claude reads `~/.claude/settings_*.json`, Codex `~/.codex/<name>.config.toml`, Copilot the CLI default or a configured model profile.

**Herdr (#1129, decision 018) is NOT a fifth provider.** It is a terminal multiplexer that HOSTS an existing agent process (claude/codex/copilot/pi) in a pane that survives the terminal closing — it has no model and no tool-call hook of its own, so it is deliberately kept out of `PROVIDER_NAMES`. Today it is config-discovery only: `GET /api/herdr/availability` (`herdr-availability.service.ts`, backed by `packages/server/src/lib/herdr-exec.ts`) probes `herdr --version` with a 30s cache, and the `herdr_hosted_agents` setting records operator intent with no launch effect yet. The actual launch wrap (mirroring `container-wrap.ts`'s pure-transform shape) is future work — see decision 018 for the open questions it must answer first (exit-code propagation, pane provisioning).

**Provider default — single source of truth = the Strategy Bullseye pref (`board_strategy_<projectId>`).** It fans out to all consumers: `selectProviderFromStrategy` → `POST /api/workspaces` default, `resolveMonitorTunables` (deterministic monitor), and a regenerated `objective.md` (the Conductor agent). Two values sit *outside* that fan-out and drift if set independently — the `provider`/`claude_profile` settings prefs (butler/review/UI) and the provider-scoped `default_model_<provider>` (claude/codex/pi; the old cross-provider global `default_model` key was retired by #902 — a cross-provider model id is now structurally unrepresentable). **To change the default, use the `set-provider-default` skill** — it sets the Bullseye, mirrors the settings prefs, scopes/clears the chosen provider's `default_model_<provider>`, and verifies all agree. Never hand-edit one source alone. (The code-level fix to collapse these is tracked on the board.)

**Precedence: Bullseye = preference, roster + quota = permission and budget, ring = backstop.** The
Bullseye (via `set-provider-default`) says which profile is PREFERRED and stays the single source of
truth for the default; the roster (#1025) says which are PERMITTED and, since #1026, measured 5-hour
headroom decides among them before the start — an exhausted pool entry is skipped rather than
launched onto, and the chosen profile plus every candidate that lost is written to the session row
(`sessions.profile_selection_reason`). The auth-rotation ring (#973) is what catches whatever that
misses: it still stamps cooldowns and rewrites the Bullseye reactively off a usage-limit text, but
it is now the backstop for a start that got through, not the trigger that moves the board.

**Profile allowlist — a per-project CONSTRAINT, not another default.** `allowed_profiles_<projectId>`
(Settings → Agent → "Profiles this project may use") lists the `{provider, name}` pairs a project is
permitted to launch on. Absent/empty = unrestricted, which is every project by default. When set it is
applied LAST, after every selector above has chosen — so it outranks an explicit per-workspace profile
override, the Strategy Bullseye, a workspace's baked-in selection, and a global `claude_profile` that the
auth-rotation ring rewrote after a usage limit. The Bullseye stays the single source of truth for *which*
profile is preferred; this decides which are *permissible*, and the two are deliberately separate concerns
(a Bullseye is a priority list that falls through on quota, which is the opposite of a restriction).
Multiple entries are fallback order: the resolver takes the first that is not cooling. When ALL of them are
cooling the project **holds** — `resolveProviderConfig` returns a `profileHold` and workspace creation
refuses with `PROFILE_ALLOWLIST_HOLD` — rather than borrowing an unlisted account, since for a project
pinned to a client subscription the wrong account is worse than no progress. A present-but-unparseable
value also holds (fail closed). Logic: `packages/shared/src/lib/profile-allowlist.ts`; enforcement seam:
`resolveProjectRuntimeConfig`.

**The roster is that allowlist with ROLES (#1025).** A flat list cannot say "emergency only",
"never", or "prefer whichever has quota left", so each profile now carries a role — `pool`
(ordinary supply, ordered by REMAINING 5-hour headroom from the quota provider, exhausted at
`roster_exhausted_pct_<id>`, default 90 %), `reserve` (only when every pool profile is exhausted or
cooling AND a grant permits it: `reserve_allowed_<id>`, the ticket tag `reserve:ok`, or an explicit
operator start — every reserve start is logged and surfaced), and `forbidden` (**refused, not
clamped** — an explicit workspace choice, a ring rewrite and a CLI `--profile` all get a refusal,
`PROFILE_FORBIDDEN`). The GLOBAL roster is not a preference: it is the role each account declares
for ITSELF (#1024, `profile-attributes.ts`), and `roster_<projectId>` may only ever NARROW it, so a
global `forbidden` is unliftable by construction. Nothing declared anywhere ⇒ unrestricted, today's
behaviour byte for byte; an existing `allowed_profiles_<id>` reads as an all-`pool` roster at READ
time (no stored value is rewritten); a project roster that is fully exhausted HOLDS exactly as the
allowlist does. Ordering decides who is picked when the roster HAS to pick — it does not preempt a
healthy explicit choice (that is predictive rotation, #1026). Logic:
`shared/lib/profile-roster.ts` + `profile-roster-selection.ts`, both re-exported through
`profile-allowlist.ts`; the enforcement seam is still `resolveProjectRuntimeConfig`, and nothing may
read the raw keys outside it (`roster-raw-read-ratchet.test.ts`).

**The guarantee stops at the machine boundary, so a restricted project goes remote only to a
worker that ATTESTS (#651, narrowed by #1027).** A fleet worker authenticates the agent with
its OWN local login and the board deliberately sends no credentials (decision 012 —
`CLAUDE_CONFIG_DIR` is not in `REMOTE_SPEC_ENV_ALLOWLIST`, by design), so the board can pick a
permitted profile but cannot *make* the worker honour it. #651's answer was therefore "never":
`resolveWorkerPlacement` refused remote placement for any project with a non-empty (or
unreadable) allowlist — host fallback, or a HOLD for a `worker_dispatch_strict` project.

**#1027 turns "never" into "only to a worker that can prove it qualifies", without moving a
credential.** A worker declares the profile NAMES it can authenticate as
(`worker start --profiles anth,team5x`, or derived from its own local profile discovery),
with the role each of those accounts declares for ITSELF and a quota reading it takes with the
same throttled OAuth reader the board runs (`server/src/lib/oauth-quota-core.ts`) against its own
tokens. Names and percentages cross the wire; tokens never do. Placement then intersects the
project's roster with that attestation and picks by role + headroom exactly as a local launch
does (`server/src/lib/worker-profile-attestation.ts` → `resolveRosterSelection` — one selection
algorithm, not two), and stamps the chosen profile NAME onto the `Placement`. The worker
resolves that name against its own logins and **rejects** the assign if it does not know it
(`profile-unknown` in the dispatch log, board re-places) — never a silent fallback to whatever
account the machine is logged into. `forbidden` still wins from either side, so a worker
attesting only a forbidden profile gets nothing. Nothing attested = today's #651 refusal, which
is also what every protocol-1 worker gets: `WORKER_PROTOCOL_VERSION` is 2 but
`MIN_SUPPORTED` stays 1, since `profiles` is an optional capability field.

