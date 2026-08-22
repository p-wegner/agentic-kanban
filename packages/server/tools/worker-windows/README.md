# Windows fleet worker: service + tray

Scripts that turn a Windows machine into an **unattended** agentic-kanban fleet
worker: the daemon keeps running after the shell that started it closes, comes
back at logon, restarts itself when the board bounces, and shows its real state
as a coloured dot in the systray.

They ship inside the npm package, so a worker machine gets them from
`npm i -g agentic-kanban` (or from a `pack-worker.mjs` tarball) instead of
someone copying files around. Find them at runtime with:

```powershell
$tools = Join-Path (npm prefix -g) 'node_modules\agentic-kanban\tools\worker-windows'
```

`agentic-kanban-worker instructions --board <url>` prints the same path,
resolved from the installed module rather than guessed.

## The scripts

| Script | What it does |
|---|---|
| `ak-worker.ps1` | Install / replace / remove the worker package itself from a tarball. Verifies `-Sha256`, refuses a tarball whose `bin` map has no `agentic-kanban-worker` key (the published 0.1.9 has only two bins, and installing it leaves a CLI with no daemon), and compares the *installed manifest* against the tarball afterwards to catch npm serving a cached same-version copy. Never touches `~/.agentic-kanban`, which holds the pairing token — losing it means re-pairing, and pairing tokens are single-use with a 10-minute expiry. |
| `ak-worker-service.ps1` | `-Install` / `-Uninstall` / `-Start` / `-Stop` / `-Restart` / `-Status` / `-Log`. Registers the Scheduled Task **`AgenticKanbanWorker`** at logon *in the user's session* — not a Windows service, because the worker runs agents with **this user's** provider credentials (the board deliberately sends none) and a SYSTEM service has no `claude` login. Needs no admin rights. Writes `%LOCALAPPDATA%\agentic-kanban-worker\config.json`. |
| `ak-worker-run.ps1` | The supervised wrapper the Scheduled Task actually runs. Not called by hand. Sets the two variables below explicitly, strips inherited `CLAUDE_*` session variables, resolves the worker binary (a task's PATH usually lacks the npm global bin), timestamps every daemon line into `%LOCALAPPDATA%\agentic-kanban-worker\worker.log`, and restarts the daemon with exponential backoff (reset after 60s of health). |
| `ak-worker-tray.ps1` | WinForms `NotifyIcon`. grey = not installed/stopped, red = daemon down or disconnected, yellow = connected but the board is unreachable from here, green = connected and idle, blue = running N sessions. State comes from the log tail plus a process check; the board `/api/health` probe runs on a slower timer. Single-instance via a named mutex. |
| `ak-worker-tray-launch.vbs` | Hidden launcher for the tray (window mode 0), so there is no permanent console window. Resolves its own folder, so it works from wherever the package is installed. |

## Install sequence

Run in **PowerShell**, in this directory, as the user whose provider credentials
the agents should use. Nothing here needs an elevated shell.

```powershell
# 0. the worker binary — from the registry if its bin map has the worker key…
npm view agentic-kanban bin
npm i -g agentic-kanban
#    …or from a tarball built on the board machine (node scripts/pack-worker.mjs):
.\ak-worker.ps1 -Tarball .\agentic-kanban-0.1.9-dev.<sha>.tgz -Sha256 <hex>
.\ak-worker.ps1 -Status

# 1. pair once, interactively, so the per-worker token lands in
#    ~/.agentic-kanban/worker-state.json (token minted on the board machine)
agentic-kanban-worker start --board <board-fleet-url> --token <pairing-token> --name $env:COMPUTERNAME
#    Ctrl+C once it reports registered.

# 2. install the background service (uses the saved token; --board is the FLEET port)
.\ak-worker-service.ps1 -Install -Board http://<board-host>:3003 `
  -Labels windows -Providers claude -MaxConcurrency 2 `
  -ClaudeConfigDir $env:USERPROFILE\.claude-work

# 3. check it, and watch the log
.\ak-worker-service.ps1 -Status
.\ak-worker-service.ps1 -Log -Tail 50

# 4. the tray dot (and, if you want it at logon, a shortcut to the .vbs in shell:startup)
wscript.exe .\ak-worker-tray-launch.vbs
```

`-Install` registers the task at **logon**, so after a reboot the worker is back
without anyone signing into a terminal. To move the worker to another board, run
`-Install` again with the new `-Board`; it rewrites the config and re-registers.

## The two variables that must be set explicitly

A Scheduled Task starts with a minimal environment and inherits nothing from an
interactive shell. That is the point, not an inconvenience — but it means these
two have to be *set*, and `ak-worker-run.ps1` sets them:

- **`ACP_AUTOCONNECT=0`** — acp reads this *before* its headless guard, so an
  inherited `1` forces auto-connect on for a headless agent, leaves a detached
  child alive, and hangs the agent forever with no output. It wedged two fleet
  dispatches on 2026-08-20.
- **`CLAUDE_CONFIG_DIR`** — decides **which account** runs the work. Unset falls
  back to `~/.claude`, which may be a different (e.g. personal) login than
  intended; the two registrations look identical and nothing board-visible tells
  them apart. Pass `-ClaudeConfigDir` at install to pin it.

## Notes

- State lives in `%LOCALAPPDATA%\agentic-kanban-worker\` (`config.json`,
  `worker.log`, rotated to `worker.log.1` past 4 MB). Pairing state lives in
  `~/.agentic-kanban\worker-state.json` and is never touched by these scripts.
- `-Board` must be the board's **fleet** port (`KANBAN_FLEET_PORT`), never its
  API port — see the networking section of
  `agentic-kanban-worker instructions --board <url>`.
- `agentic-kanban-worker --version` is not a reliable version check (it has been
  hardcoded). `.\ak-worker.ps1 -Status` reads the installed manifest instead.
