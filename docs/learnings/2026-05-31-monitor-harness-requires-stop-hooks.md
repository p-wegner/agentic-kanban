# Monitor Harness Must Have Stop Hooks and Commit Its Own Fixes

## What happened

On 2026-05-31 a long-running **monitor harness** — a Codex session running *outside*
the kanban board (the kind we launch with a `/goal`-style command or cron to keep the
board moving: pull tickets, nudge agents, auto-merge, fix setup bugs) — spent ~8.5 hours
babysitting a single issue (#160) and stalled instead of making progress.

Root cause was a chain of three real setup bugs the monitor correctly diagnosed and fixed
**in the main checkout** — but never committed:

- Codex launched with `--profile-v2` (invalid; the installed CLI only accepts `--profile`),
  so every codex conflict-resolver session exited code 2 instantly (the "0-second,
  zero-token" sessions).
- Conflict-resolution sessions ran multi-turn, leaving stdin open; `codex exec` expects EOF
  and exited immediately.
- `fix-and-merge` rebased onto stale `origin/<base>` instead of local `master`, leaving the
  branch 110 commits behind.

The fixes were correct, but because they sat **uncommitted in the main checkout**:

- They were invisible and one `git restore` / hot-reload away from being lost.
- They **blocked auto-merge** — the merge queue refuses to land work when the main checkout
  has uncommitted tracked changes (see the dirty-main merge block).
- The monitor kept relaunching a resolver that the *uncommitted* fix would have repaired,
  so it spun in a respawn loop making no durable progress.

In short: **a monitor that changes master but does not commit stalls the entire board.**

## Lessons

- **The monitor harness must commit.** If the monitor finds a bug in the setup or otherwise
  needs to change `master` (provider flags, hooks, git logic), it must commit those changes
  immediately. Uncommitted fixes in the main checkout strand progress: they block the merge
  queue and can be silently lost. Committing is not optional housekeeping — it is the
  difference between progress and a stall.

- **This requires the harness to support a proper Stop hook.** The commit-discipline
  guardrail is `.claude/hooks/check-uncommitted.js`: on stop, if the session owns no
  workspace (i.e. it is the monitor or an interactive session operating in the main
  checkout), it warns when the main checkout has uncommitted tracked
  `packages/**/*.{ts,tsx,sql}`. That guard can only fire if the harness emits a Stop /
  turn-complete lifecycle event.

- **Verify the harness actually has Stop hooks before trusting the guard.** Claude Code has a
  `Stop` hook. Codex CLI **0.132+** also has a `Stop` hook (matcher-less, fires on *turn*
  completion — not reliably on Esc-interrupt, and there is no separate `SessionEnd` yet; see
  openai/codex#20603). Both are now wired (`.claude/settings.json` → smart-hooks-runner,
  and `.codex/hooks.json` → check-uncommitted directly). A harness *without* a Stop hook
  silently has no commit-discipline net.

- **Don't route a per-turn Stop hook through the heavy Stop suite.** Codex `Stop` fires every
  turn, so it routes straight to `check-uncommitted.js`, not the full smart-hooks Stop suite
  (which runs vitest + `pnpm build`). `check-uncommitted` honors `stop_hook_active` to nudge
  once per turn and avoid a continue-loop.

- **Treat a 1-second, zero-token provider transcript as a failed launch**, and a monitor that
  relaunches the same resolver repeatedly as a respawn loop — stop it and inspect the setup,
  don't wait through polling.

## Where this is documented

- Operational requirement: `docs/provider-requirements.md` → "Harness Lifecycle Hook
  Requirements".
- Guardrail implementation: `.claude/hooks/check-uncommitted.js`, wired in
  `.claude/settings.json` and `.codex/hooks.json`.
- Root-cause fix commit: `f63fc11e`; main-checkout guard: `43c9beba`; codex Stop wiring:
  `624c6b67`.

## Follow-up tickets

- #190 Board-level dirty-main-checkout guard (harness-agnostic commit discipline) — catches the
  stall even when the monitor harness has no Stop hook.
- Detect and fail zero-output / respawn-loop monitor sessions (relates to #169).
- Re-evaluate the guard when Codex ships a true `SessionEnd` hook (openai/codex#20603) — a
  per-turn Stop is a coarser signal than session exit.
