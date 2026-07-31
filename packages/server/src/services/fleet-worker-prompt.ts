// The `fleet-worker` builtin skill's prompt, kept out of builtin-skills.ts so that
// registry stays a readable table of skills instead of a wall of prose (same reason
// MERGE_RECONCILER_PROMPT lives in its own module). The canonical runbook is the
// CLI's `worker instructions` command — this prompt deliberately points at it rather
// than restating commands, so the two cannot drift.

export const FLEET_WORKER_PROMPT = `You are setting up the machine you are running on as a **fleet worker** for a remote agentic-kanban board. When it is connected, the board can schedule ticket work onto this machine instead of running every agent on the board host.

Do NOT guess at commands — the CLI ships the canonical runbook with the caller's board URL filled in:

\`\`\`bash
agentic-kanban worker instructions --board <board-url>
agentic-kanban worker instructions --board <board-url> --json   # same steps, machine-readable
\`\`\`

Follow that output. The rest of this skill is the context you need to follow it correctly and to recognise when something is actually wrong.

## How it works (so you can reason about failures)
- **The worker dials the board**, never the reverse. It registers over REST, then holds a WebSocket open for assignments. This machine does NOT need to be reachable from outside — only the board does.
- **Credentials never travel.** The agent runs here with THIS machine's own provider login. The board sends a launch spec, not an API key. If the provider CLI is not logged in here, sessions will fail no matter how healthy the connection looks.
- **Code moves over git.** For a worker on a different machine, the board serves the repo over token-authed git-over-HTTP. The worker clones it, works in its own checkout, and pushes to \`refs/kanban/incoming/<branch>\`. The board fast-forwards the real branch from there, then its normal diff/review/merge flow applies. You never push to \`refs/heads/*\` — the board refuses that, on purpose.
- **Same machine as the board?** Pass \`--shares-filesystem\`. The worker then runs agents directly in the board's own worktrees and skips git transport entirely. Using it across machines is wrong and will fail confusingly.

## Steps at a glance
1. **Prerequisites (here):** \`git\` on PATH; the provider CLI (\`claude\` / \`codex\` / \`copilot\`) installed AND logged in.
2. **Reachability (here):** \`curl <board-url>/api/health\` must answer. A board on 127.0.0.1 is unreachable from another machine — it must run with \`KANBAN_HOST=0.0.0.0\`.
3. **Pairing token (board machine):** \`agentic-kanban worker pair\` — single-use, expires in 10 minutes. Or the Workers UI panel (command palette → "Worker Fleet" → Mint token).
4. **Start (here):** \`agentic-kanban worker start --board <url> --token <pairing-token> --labels <caps> --providers <clis> --max-concurrency <n>\`. Runs in the foreground. The pairing token becomes a per-worker token stored in \`~/.agentic-kanban/worker-state.json\`, so later runs need no \`--token\`.
5. **Verify:** \`agentic-kanban worker list --board <url>\` — this worker must read \`online\`.
6. **Opt a project in (board machine):** registration alone routes nothing. Set \`worker_dispatch_<projectId>=true\`; optionally \`worker_labels_<projectId>\` to require capabilities and \`worker_dispatch_strict_<projectId>=true\` to forbid falling back to the board host.

## Reporting back
State plainly: the worker id and name, its effective status from \`worker list\`, the labels/providers/concurrency it advertised, and whether a project was opted in. If you could not complete a step, say which one and what the error was — do not report a worker as connected because the command started without an immediate error.

## Troubleshooting
- **\`invalid or expired pairing token\`** — tokens are single-use and 10-minute-lived. Mint a fresh one; do not reuse the old one.
- **Registration connection refused** — the board is loopback-only or firewalled. It needs \`KANBAN_HOST=0.0.0.0\` and its API port (3001 by default) open to this machine.
- **Registered but reads \`offline\`** — heartbeats stop after 90s of silence. The daemon exited or lost its socket; check it is still running in the foreground.
- **Online but nothing is ever assigned** — the project has not opted in (\`worker_dispatch_<projectId>\`), OR its \`worker_labels_<projectId>\` require labels this worker did not advertise, OR every slot is busy (\`--max-concurrency\`), OR its provider is not in this worker's \`--providers\` list.
- **Sessions start then fail immediately** — almost always the provider CLI here is missing or not logged in. Run it manually once on this machine.
- **Clone/fetch fails or hangs** — the git-transport port is not reachable. It is OS-assigned per board boot unless the board pins it with \`KANBAN_GIT_HTTP_PORT\`; a cross-machine setup must pin it and open that port too.
- **Work runs but never lands on the branch** — the board holds a push it cannot fast-forward (the branch diverged). The commits are safe in \`refs/kanban/incoming/<branch>\`; it needs a human decision, and force-landing it would discard one side.

## Do not
- Do not copy board credentials, \`~/.claude\` directories, or API keys onto this machine to "make auth work" — log the provider CLI in here instead.
- Do not expose the board to the open internet. The worker endpoints are token-authed, but the rest of the board API is not; keep it on a trusted network (LAN/VPN/Tailscale).
- Do not hand-edit \`~/.agentic-kanban/worker-state.json\`. To re-pair, revoke the worker on the board and start again with a fresh token.`;
