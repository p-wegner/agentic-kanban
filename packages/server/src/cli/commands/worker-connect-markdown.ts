// `worker instructions` markdown + the Windows tools-dir resolver, split out of worker.ts (#1605); re-exported there.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerConnectStep } from "@agentic-kanban/shared/lib/worker-connect-steps";

/** Directory of shipped Windows service/tray scripts, relative to the package root. */
const WINDOWS_TOOLS_SUBDIR = join("tools", "worker-windows");

/**
 * Absolute path of the shipped Windows service/tray scripts, or null if they are
 * not next to this module.
 *
 * Resolved by walking up from THIS module rather than from `npm prefix -g`,
 * because the same code runs from three different depths — the esbuild bundle at
 * `dist/worker.js`, the tsc output at `dist/cli/commands/worker.js`, and
 * `src/cli/commands/worker.ts` under tsx in a dev checkout — and because a global
 * prefix is exactly the thing that differs per machine (nvm, Scoop, a per-user
 * prefix), so hardcoding one prints a path that does not exist for the reader.
 */
export function resolveWindowsToolsDir(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, WINDOWS_TOOLS_SUBDIR);
    // Probe a file, not the directory: an empty `tools/` must not count as a hit.
    if (existsSync(join(candidate, "ak-worker-service.ps1"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
/**
 * Windows-only: point the reader at the service/tray scripts that ship IN the
 * package, so an unattended worker is a documented install step rather than
 * scripts someone hand-copies between machines. Kept out of the numbered steps
 * because it is optional and platform-specific — the foreground `start` above is
 * what proves the pairing works, and this survives the shell closing.
 */
function renderWindowsServiceSection(): string[] {
  const toolsDir = resolveWindowsToolsDir();
  // Not found = running from somewhere the scripts were not shipped to. Say how
  // to locate them rather than printing a path that is wrong on this machine.
  const dir = toolsDir ?? "$(Join-Path (npm prefix -g) 'node_modules\\agentic-kanban\\tools\\worker-windows')";
  const lines: string[] = [];
  lines.push("## Windows: keep the worker running unattended (optional)");
  lines.push("");
  lines.push(
    "The foreground `start` above dies with its shell. On Windows the package ships scripts that register the " +
      "worker as the Scheduled Task `AgenticKanbanWorker` — at logon, in YOUR session, so agents keep using this " +
      "account's provider credentials — under a supervisor that restarts the daemon with backoff, plus a systray " +
      "dot for its real state. They live inside the installed package here:",
  );
  lines.push("");
  lines.push("```text");
  lines.push(dir);
  lines.push("```");
  lines.push("");
  lines.push("```powershell");
  lines.push(`Set-Location "${dir}"`);
  lines.push("");
  lines.push("# install + start the background service (-Board is the board's FLEET port)");
  lines.push(".\\ak-worker-service.ps1 -Install -Board <board-url> -Labels windows -Providers claude -ClaudeConfigDir $env:CLAUDE_CONFIG_DIR");
  lines.push(".\\ak-worker-service.ps1 -Status");
  lines.push(".\\ak-worker-service.ps1 -Log -Tail 50");
  lines.push("");
  lines.push("# the systray dot (hidden launcher; shortcut it into shell:startup to get it at logon)");
  lines.push("wscript.exe .\\ak-worker-tray-launch.vbs");
  lines.push("```");
  lines.push("");
  lines.push(
    "Pair once in the foreground first (the step above): the service reuses the saved per-worker token. No admin " +
      "rights are needed. Set `-ClaudeConfigDir` explicitly — a Scheduled Task inherits nothing, and an unset " +
      "`CLAUDE_CONFIG_DIR` silently runs the agents under the default `~/.claude` account. The supervisor also " +
      "forces `ACP_AUTOCONNECT=0`, without which a headless agent can hang forever with no output. See the " +
      "README in that directory for the rest.",
  );
  lines.push("");
  return lines;
}

export function renderWorkerConnectMarkdown(
  boardUrl: string,
  pairingToken: string,
  steps: WorkerConnectStep[],
): string {
  const lines: string[] = [];
  lines.push(`# Connect this machine to ${boardUrl} as a fleet worker`);
  lines.push("");
  lines.push(
    "The board schedules agent sessions onto connected workers. This machine clones the repo from the board over " +
      "git-over-HTTP, runs the agent in its own checkout, and pushes the result back — the board then lands the " +
      "branch and its normal review/merge flow takes over.",
  );
  lines.push("");
  steps.forEach((step, index) => {
    const scope = step.where === "board" ? " *(run on the BOARD machine)*" : step.where === "either" ? " *(either machine)*" : "";
    lines.push(`## ${index + 1}. ${step.title}${scope}`);
    lines.push("");
    lines.push(step.detail);
    if (step.commands.length > 0) {
      lines.push("");
      lines.push("```bash");
      lines.push(...step.commands);
      lines.push("```");
    }
    lines.push("");
  });
  lines.push(...renderWindowsServiceSection());
  lines.push("## Board-side networking (cross-machine only)");
  lines.push("");
  lines.push(
    "A default board is loopback-only and unreachable from other machines. Do NOT open it with KANBAN_HOST — the " +
      "board API has no authentication, so binding it to 0.0.0.0 would publish every issue, transcript and merge " +
      "endpoint to the network. Instead open the two purpose-built listeners, each of which authenticates every " +
      "request with a bearer token:",
  );
  lines.push("");
  lines.push("```bash");
  lines.push("KANBAN_FLEET_PORT=3003 KANBAN_GIT_HTTP_PORT=3002 pnpm dev   # board machine");
  lines.push("");
  lines.push("# VPN-only: bind both listeners to the VPN interface instead of every interface");
  lines.push("KANBAN_FLEET_PORT=3003 KANBAN_FLEET_HOST=100.x.y.z \\");
  lines.push("KANBAN_GIT_HTTP_PORT=3002 KANBAN_GIT_HTTP_HOST=100.x.y.z pnpm dev");
  lines.push("```");
  lines.push("");
  lines.push(
    "`KANBAN_FLEET_PORT` serves ONLY worker register/heartbeat/WebSocket; `KANBAN_GIT_HTTP_PORT` serves ONLY the " +
      "git transport (pin it — otherwise it moves every boot and no firewall rule can match). The board API itself " +
      "stays on 127.0.0.1 and is not reachable from the network at all. Point a remote worker's --board at the " +
      "FLEET port. Still keep the board on a trusted network (LAN/VPN/Tailscale) rather than the open internet.",
  );
  lines.push("");
  lines.push(
    "`KANBAN_FLEET_HOST` / `KANBAN_GIT_HTTP_HOST` narrow WHICH interface each listener binds (absent = every " +
      "interface, as before). On a VPN this is what makes \"trusted network\" a control rather than a hope: " +
      "with the bind host set to the VPN address, the two ports do not exist on the office LAN, the home LAN or " +
      "hotel wifi at all, so reaching them requires being on the VPN — the bearer tokens stop being the only " +
      "thing between a stranger's packet and the board.",
  );
  lines.push("");
  lines.push(
    "**Do not put a path-based reverse proxy in front of the git transport** (`tailscale serve`, an nginx " +
      "location prefix). The worker builds its clone URL as `scheme://<board-host>:<git-port>/git/<projectId>` — " +
      "it discards any path prefix and substitutes the port it was told, so behind a serve-style proxy the clone " +
      "hangs with no obvious cause. Use the machine's own name/address (e.g. MagicDNS) with the ports directly. " +
      "Tailscale Funnel must never be used: that is the public internet in front of a board.",
  );
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- **Same machine as the board?** Add `--shares-filesystem` to `worker start`. The worker then runs agents " +
      "directly in the board's worktrees and skips git transport entirely.",
  );
  lines.push(
    "- **Stopping**: Ctrl+C kills the running agents too; `--leave-agents` leaves them alive. Losing the connection " +
      "does NOT kill agents — the daemon reconnects with backoff and keeps their exit events queued.",
  );
  lines.push(
    "- **Revoking**: `agentic-kanban worker list` then the Workers UI panel's Revoke button (or " +
      "`DELETE /api/workers/:id`). The worker's token stops working immediately.",
  );
  lines.push(
    "- **Disk**: the worker keeps one clone per project plus a per-session worktree under `~/.agentic-kanban/worker` " +
      "(override with `--work-root`).",
  );
  return lines.join("\n");
}

