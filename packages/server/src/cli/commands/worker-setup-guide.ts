/**
 * First-install guidance for a worker machine (#1358). Pure strings, no db graph: this ships in
 * the standalone worker binary, so it is the one place a newcomer can read the setup steps
 * without the repo's `docs/worker-fleet.md` (which is not in the npm package).
 *
 * Doctor remedies cite `WORKER_SETUP_HELP` instead of a repo doc path.
 */

/** The command a worker owner runs to read the guide. Cited by every doctor remedy. */
export const WORKER_SETUP_HELP = "`agentic-kanban-worker setup`";

/**
 * Exact commands for a machine that has only node: download the board-served build with the
 * pairing token (the board does not consume it for /build), verify sha256, install, pair.
 */
export function renderBootstrapSteps(fleetUrl: string, pairingToken: string): string {
  const base = fleetUrl.replace(/\/+$/, "");
  return [
    "On a FRESH machine with only node installed (no worker yet):",
    "  (The commands are for Windows: curl.exe ships with Windows 10+ and also works in PowerShell 7, while in",
    "   Windows PowerShell 5.1 plain `curl` is Invoke-WebRequest and rejects these flags. macOS/Linux: type curl.)",
    `  1. Fetch the build manifest (note "sha256"; waits up to 120 s while the board packs this commit):`,
    `       curl.exe -fsS -H "Authorization: Bearer ${pairingToken}" "${base}/api/workers/build?wait=120"`,
    `  2. Download the tarball (the pairing token is NOT consumed by this):`,
    `       curl.exe -fL -H "Authorization: Bearer ${pairingToken}" -o agentic-kanban-worker.tgz "${base}/api/workers/build/tarball?wait=120"`,
    `  3. Verify it equals the sha256 from step 1:`,
    `       node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('agentic-kanban-worker.tgz')).digest('hex'))"`,
    `  4. Install:`,
    `       npm i -g ./agentic-kanban-worker.tgz`,
    `  5. Pair and run:`,
    `       agentic-kanban-worker start --board ${base} --token ${pairingToken}`,
    "(Steps 1 and 2 wait for the board to finish packing its build; if it takes longer than 120 s they fail with",
    " HTTP 504 and a non-zero exit - stop there and re-run that step, do not continue to step 3.)",
  ].join("\n");
}

/** The offline setup guide printed by `worker setup`. Section numbers are what doctor remedies cite. */
export function renderWorkerSetupGuide(): string {
  return [
    "Agentic Kanban worker - setup guide",
    "",
    "1. Two halves. A worker machine runs `agentic-kanban-worker`; the board machine runs the board.",
    "   The worker cannot ask the board about its own health from the board's loopback API, so",
    "   `worker doctor` (here) checks the worker side and `worker doctor-board` (on the board) the other.",
    "",
    "2. First install. On the BOARD machine run `agentic-kanban worker pair`. It prints a single-use",
    "   pairing token plus the exact commands for a fresh machine: download the build with the token,",
    "   verify its sha256, `npm i -g <tarball>`, then `start --board <fleet-url> --token <token>`.",
    "   The token may be used for the download without being consumed; pairing consumes it.",
    "",
    "3. Pairing is saved to a state file; later runs of `start` reuse it and need no token.",
    "   Updates: `worker update-check` (add --apply to update now).",
    "",
    "4. Network. The board's fleet listener must be reachable from the worker (tailnet/LAN).",
    "   Use the address `worker pair` printed; check with `worker doctor`.",
    "",
    "5. Providers. Install the agent CLIs (claude/codex/...) here, then log them into the WORKER's own",
    "   clean config dir (<state-dir>/harness/<provider>, no user hooks/plugins): `worker auth claude`",
    "   (or `worker auth claude --token` for a headless box), `worker auth codex`. `worker auth --status`",
    "   shows the mode per provider; `worker doctor` reports missing or expired credentials.",
    "   Credentials are created on this machine and never leave it. To use your own ~/.claude instead:",
    "   `start --inherit-user-config` (dirty mode); a dedicated folder: `start --config-dir <path>`.",
    "",
    "6. Firewall / exposure. On the BOARD machine, from its agentic-kanban checkout (the script is not in",
    "   this worker package), scope the fleet port to the tailnet (100.64.0.0/10) with",
    "   `scripts/fleet-firewall.ps1 -Install` (elevated). Never expose the fleet port publicly. Setting",
    "   KANBAN_FLEET_INSECURE=1 accepts every interface and is for trusted LANs only.",
    "",
    "7. Nothing dispatches? Run `worker doctor` here, `worker doctor-board` on the board, then",
    "   `worker explain`/`worker placements` to see why a ticket was not placed on this worker.",
    "",
    "8. Proxies. A reverse proxy in front of the fleet port is the usual cause of odd 4xx/WebSocket",
    "   failures; point `--board` at the fleet listener directly.",
  ].join("\n");
}
