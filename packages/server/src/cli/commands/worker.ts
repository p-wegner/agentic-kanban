import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  startWorkerDaemon,
  defaultWorkerStateFile,
  DEFAULT_DRAIN_TIMEOUT_MS,
  WorkerRegistrationRefused,
} from "../../worker/worker-daemon.js";
import { SHARES_FILESYSTEM_LABEL } from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
// Type-only + a db-free formatter: this module is also the standalone worker
// binary's entry point, which must never pull in the database graph.
import { renderPlacementExplanation } from "../../lib/placement-explanation-format.js";
import type { IssuePlacementReport, SessionPlacementRecord } from "../../lib/placement-explain.types.js";
// #774 — the connectivity self-test. Db-free on purpose: this module is also the standalone
// worker binary's entry point (docs/worker-fleet.md §3).
import { renderDoctorReport, runBoardDoctor, runWorkerDoctor } from "./worker-doctor.js";

const DEFAULT_BOARD_URL = "http://127.0.0.1:3001";

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

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export interface WorkerConnectStep {
  title: string;
  detail: string;
  /** Commands to run for this step, in order. Empty for check-only steps. */
  commands: string[];
  /** Where the step runs — worker machine, board machine, or either. */
  where: "worker" | "board" | "either";
}

/**
 * The connect runbook, as data. Exported so `worker instructions --json`, the
 * `fleet-worker` agent skill and the docs all render the SAME steps instead of
 * three copies that drift.
 */
export function buildWorkerConnectSteps(boardUrl: string, pairingToken: string): WorkerConnectStep[] {
  return [
    {
      title: "Verify the prerequisites on this machine",
      where: "worker",
      detail:
        "A worker runs agents with ITS OWN credentials — the board never sends any. So the provider CLI must be " +
        "installed here and already logged in, and git must be on PATH. No board checkout is needed and the " +
        "board's database is never accessed: the worker speaks only HTTP/WebSocket.",
      commands: ["git --version", "claude --version   # or: codex --version / copilot --version"],
    },
    {
      title: "Get the worker binary onto this machine",
      where: "worker",
      detail:
        "Do NOT assume `npm i -g agentic-kanban` provides it. The published package can lag this tree: 0.1.9 on " +
        "the registry was released BEFORE the worker fleet landed, so its bin map has no `agentic-kanban-worker` " +
        "key at all — the install succeeds and the binary is simply absent. Check the registry before relying on " +
        "it (`npm view agentic-kanban bin`); if the worker key is missing, use the tarball fast track instead: on " +
        "the BOARD machine run `node scripts/pack-worker.mjs`, which builds, refuses to pack a tarball whose bin " +
        "map lacks the worker, and stamps a `<version>-dev.<sha>` prerelease so npm can never serve a cached " +
        "same-version copy in its place. Copy the tarball here and install it by path. `--blob` additionally " +
        "puts it on an ACP relay and prints a ref, for a machine you cannot copy files to directly. " +
        "Verify the install: `--version` reports the version from the installed manifest, so it must echo the " +
        "tarball's `-dev.<sha>` stamp back. A bare `0.0.1` means an old build (the version used to be hardcoded); " +
        "the registry's plain `0.1.9` means npm served a cached copy instead of your file. " +
        "An ERESOLVE peer warning about `zod` on install is EXPECTED and harmless: the agent SDK declares a " +
        "`zod ^4` peer while this tree pins 3.x, but that peer is type-level only (no runtime file in the SDK " +
        "imports zod) — see the note in pnpm-workspace.yaml. It does not affect the worker, which does not bundle " +
        "the SDK at all.",
      commands: [
        "npm view agentic-kanban bin   # does the published bin map have agentic-kanban-worker?",
        "npm i -g <path-to-agentic-kanban-*.tgz>",
        "agentic-kanban-worker --version        # must print the tarball's version, not 0.0.1",
        "npm ls -g --depth 0 agentic-kanban     # cross-check: catches npm serving a cached copy",
      ],
    },
    {
      title: "Confirm the board is reachable from here",
      where: "worker",
      detail:
        `Anything other than a connection error means the board is reachable. Use the board's FLEET port here, not ` +
        `its API port — a remote worker never talks to the board API. If this refuses to connect, the board is ` +
        `not exposing a fleet listener yet (see the board-side note below).`,
      commands: [`curl -s -o /dev/null -w "%{http_code}\\n" ${boardUrl}/api/health`],
    },
    {
      title: "Mint a pairing token (on the board machine)",
      where: "board",
      detail:
        "Pairing tokens are single-use and expire in 10 minutes. Mint one on the board host (the mint endpoint " +
        "rides the board's loopback trust), or use the Workers UI panel: command palette → \"Worker Fleet\" → " +
        "Mint token. Copy the token to this machine.",
      commands: ["agentic-kanban worker pair"],
    },
    {
      title: "Start the worker daemon",
      where: "worker",
      detail:
        "Registers with the board, then holds a WebSocket open for assignments. The pairing token is exchanged for " +
        "a per-worker token saved in ~/.agentic-kanban/worker-state.json, so later runs need no --token. Set " +
        "--labels to advertise capabilities a project can require, --providers to declare which agent CLIs work " +
        "here, and --max-concurrency for how many sessions this machine should take. Runs in the foreground until " +
        "Ctrl+C. `agentic-kanban-worker` is the standalone binary for worker machines — it loads only the " +
        "daemon and never touches a database; on a machine that also runs the board, `agentic-kanban " +
        "worker start` is equivalent.",
      commands: [
        `agentic-kanban-worker start --board ${boardUrl} --token ${pairingToken} \\`,
        `  --name "$(hostname)" --labels docker,linux --providers claude --max-concurrency 2`,
      ],
    },
    {
      title: "Verify the board sees this worker",
      where: "either",
      detail:
        "The worker should be listed as `online` with the labels and capacity you passed. It reads `offline` if its " +
        "heartbeat is older than 90s — that means the daemon died or lost the connection.",
      commands: [`agentic-kanban-worker list --board ${boardUrl}`],
    },
    {
      title: "Opt a project into dispatching work here",
      where: "board",
      detail:
        "Registration alone does not route work. A project opts in with worker_dispatch_<projectId>; it can require " +
        "capabilities with worker_labels_<projectId>, and worker_dispatch_strict_<projectId> forbids the silent " +
        "fallback to running on the board host (the monitor then reports the no_available_worker skip reason " +
        "instead). Get the project id from `agentic-kanban list`.",
      commands: [
        "agentic-kanban preferences set worker_dispatch_<projectId> true",
        "agentic-kanban preferences set worker_labels_<projectId> docker,linux    # optional",
        "agentic-kanban preferences set worker_dispatch_strict_<projectId> true   # optional",
      ],
    },
  ];
}

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

/**
 * `worker` — run this machine as a fleet worker for a (possibly remote) board
 * (epic #1, phase 1b #4). Unlike the rest of the CLI, these commands talk to
 * the board over HTTP/WS only — they never open the local DB, so they work on
 * machines that have no board checkout at all.
 */
export function registerWorkerCommand(program: Command) {
  const workerCmd = program
    .command("worker")
    .description("Fleet worker: connect this machine to a board and execute assigned agent sessions.\n\nSubcommands: pair, start, instructions, list, explain, placements, doctor, doctor-board");
  registerWorkerSubcommands(workerCmd);
}

/**
 * Attach pair/start/instructions/list to `parent`.
 *
 * Split from registerWorkerCommand so the SAME commands can hang off the
 * `worker` subcommand of the main CLI *and* off the root of the standalone
 * `agentic-kanban-worker` binary — which exists so a worker machine can run
 * the daemon without loading the board CLI's command tree (and with it the
 * database layer). Everything reachable from here must stay free of
 * board-server imports; see worker/worker-cli.ts.
 */
export function registerWorkerSubcommands(workerCmd: Command) {
  workerCmd
    .command("pair")
    .description(
      "Mint a short-lived, single-use pairing token on the board (run this WHERE THE BOARD RUNS; " +
        "the mint endpoint rides the board's loopback trust). Hand the token to 'worker start --token' on the worker machine.",
    )
    .option("--board <url>", "Board base URL", DEFAULT_BOARD_URL)
    .action(async (options: { board: string }) => {
      const res = await fetch(`${options.board.replace(/\/+$/, "")}/api/workers/pairing-token`, { method: "POST" });
      if (!res.ok) {
        console.error(`Failed to mint pairing token (${res.status}). Is the board running at ${options.board}?`);
        process.exit(1);
      }
      const body = await res.json() as { pairingToken: string; expiresAt: string };
      console.log(`Pairing token (single-use, expires ${body.expiresAt}):`);
      console.log(`  ${body.pairingToken}`);
      console.log(`\nOn the worker machine:`);
      console.log(`  agentic-kanban-worker start --board <board-url> --token ${body.pairingToken}`);
    });

  workerCmd
    .command("start")
    .description(
      "Run the worker daemon: register with the board (first run needs --token from 'worker pair'), " +
        "hold a WebSocket for assignments, execute agent sessions locally, stream output back. " +
        "Runs until Ctrl+C; running agents are killed on exit unless --leave-agents.",
    )
    .option("--board <url>", "Board base URL", DEFAULT_BOARD_URL)
    .option("--token <pairingToken>", "Pairing token for first registration (ignored once paired)")
    .option("--name <name>", "Worker display name (default: hostname)")
    .option("--labels <csv>", "Capability labels, e.g. docker,windows")
    .option(
      "--shares-filesystem",
      "This worker sees the board's filesystem (same machine): run agents directly in the board's worktrees " +
        "instead of cloning over git transport. Only correct when board and worker share a disk.",
    )
    .option("--providers <csv>", "Agent providers available here, e.g. claude,codex")
    .option("--max-concurrency <n>", "Max parallel agent sessions", (v) => parseInt(v, 10))
    .option("--state-file <path>", `Pairing state file (default: ${defaultWorkerStateFile()})`)
    .option("--work-root <path>", "Root for git-transport clones/checkouts (default: ~/.agentic-kanban/worker)")
    .option("--leave-agents", "On Ctrl+C, leave running agent processes alive instead of killing them")
    .option(
      "--drain-timeout <seconds>",
      "On Ctrl+C, how long to wait for finished agents' results to finish pushing to the board " +
        `(default ${Math.round(DEFAULT_DRAIN_TIMEOUT_MS / 1000)})`,
      (v) => parseInt(v, 10),
    )
    .action(async (options: {
      board: string;
      token?: string;
      name?: string;
      labels?: string;
      providers?: string;
      maxConcurrency?: number;
      stateFile?: string;
      workRoot?: string;
      sharesFilesystem?: boolean;
      leaveAgents?: boolean;
      drainTimeout?: number;
    }) => {
      try {
        const labels = splitList(options.labels) ?? [];
        if (options.sharesFilesystem && !labels.includes(SHARES_FILESYSTEM_LABEL)) {
          labels.push(SHARES_FILESYSTEM_LABEL);
        }
        // The reconnect timers are unref'd; this keeps the CLI process alive.
        const keepAlive = setInterval(() => {}, 60_000);
        const drainTimeoutMs = options.drainTimeout !== undefined && options.drainTimeout > 0
          ? options.drainTimeout * 1000
          : undefined;
        const daemon = await startWorkerDaemon({
          boardUrl: options.board,
          pairingToken: options.token,
          name: options.name,
          labels: labels.length > 0 ? labels : undefined,
          providers: splitList(options.providers),
          maxConcurrency: options.maxConcurrency,
          stateFile: options.stateFile,
          workRoot: options.workRoot,
          drainTimeoutMs,
          // #754: a revoked worker, or one the board refuses on protocol grounds, used to
          // retry every 30 s forever with a red tray and nothing in any log saying why.
          // It is now a clean non-zero exit carrying the reason — which is also what makes
          // a supervisor (the Windows scheduled task) stop restarting it into the same wall.
          onFatal: (reason) => {
            console.error(`[worker] ${reason}`);
            clearInterval(keepAlive);
            process.exit(2);
          },
        });
        let shuttingDown = false;
        const shutdown = () => {
          // Ctrl+C twice must still get you out, even if a push is hung on a slow link.
          if (shuttingDown) {
            console.log("[worker] second interrupt — exiting without waiting for the drain");
            process.exit(130);
          }
          shuttingDown = true;
          console.log("\n[worker] shutting down" + (options.leaveAgents ? " (leaving agents running)" : ""));
          // #754: AWAIT the drain. This used to be a sync stop() followed immediately by
          // process.exit(0), so with the agents killed the process was gone before their
          // exit handlers could push the results back — completed work was silently lost
          // and the board reported it as a failure 60 s later.
          void daemon.stop({ killAgents: !options.leaveAgents }).then((report) => {
            clearInterval(keepAlive);
            if (options.leaveAgents && report.agentsLeftRunning > 0) {
              console.log(
                `[worker] ${report.agentsLeftRunning} agent(s) left running. Their results CANNOT be ` +
                  "pushed by a future daemon — the checkout mapping lives in this process only — so " +
                  "the board will fall back to its disconnect grace for them.",
              );
            }
            process.exit(report.pushesAbandoned > 0 || report.criticalMessagesLost > 0 ? 1 : 0);
          }, (err: unknown) => {
            console.error(`[worker] drain failed: ${errorMessage(err)}`);
            clearInterval(keepAlive);
            process.exit(1);
          });
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        console.error(errorMessage(err));
        // A build the board refuses is not a usage error and not a transient one: give it
        // its own code so a supervisor can tell "fix the install" from "try again" (#754).
        process.exit(err instanceof WorkerRegistrationRefused ? 2 : 1);
      }
    });

  workerCmd
    .command("instructions")
    .description(
      "Print a step-by-step runbook for connecting THIS machine to a remote board as a worker. " +
        "Written to be followed by an agent (or a human) with no prior context — pass --board to " +
        "get the commands pre-filled, and --token if you already minted a pairing token.",
    )
    .option("--board <url>", "Board base URL to embed in the instructions", DEFAULT_BOARD_URL)
    .option("--token <pairingToken>", "Pairing token to embed, if you already have one")
    .option("--json", "Emit the steps as JSON instead of Markdown")
    .action((options: { board: string; token?: string; json?: boolean }) => {
      const board = options.board.replace(/\/+$/, "");
      const token = options.token ?? "<pairing-token>";
      const steps = buildWorkerConnectSteps(board, token);
      if (options.json) {
        console.log(JSON.stringify({ boardUrl: board, steps }, null, 2));
        return;
      }
      console.log(renderWorkerConnectMarkdown(board, token, steps));
    });

  workerCmd
    .command("list")
    .description("List the board's registered workers with their effective status.")
    .option("--board <url>", "Board base URL", DEFAULT_BOARD_URL)
    .option("--json", "Output raw JSON")
    .action(async (options: { board: string; json?: boolean }) => {
      const res = await fetch(`${options.board.replace(/\/+$/, "")}/api/workers`);
      if (!res.ok) {
        console.error(`Failed to list workers (${res.status}). Is the board running at ${options.board}?`);
        process.exit(1);
      }
      const body = await res.json() as { workers: Array<{ id: string; name: string; effectiveStatus: string; status: string; os: string | null; labels: string | null; maxConcurrency: number; lastHeartbeatAt: string | null; protocolVersion?: number; workerVersion?: string }> };
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      if (body.workers.length === 0) {
        console.log("No workers registered.");
        return;
      }
      for (const w of body.workers) {
        const labels = w.labels ? ` labels=${w.labels}` : "";
        // #754: "which build is that machine running" was unanswerable from the board, and
        // with dev tarballs it is the first question a skew bug raises. `?` means the
        // worker has not spoken since this board started — not that it is old.
        const build = ` protocol=${w.protocolVersion ?? "?"} build=${w.workerVersion ?? "?"}`;
        console.log(`  ${w.name} [${w.effectiveStatus}] id=${w.id} os=${w.os ?? "?"} maxConcurrency=${w.maxConcurrency}${labels}${build} lastHeartbeat=${w.lastHeartbeatAt ?? "never"}`);
      }
    });

  workerCmd
    .command("explain <issue>")
    .description(
      "Why was #N not dispatched to a worker? Walks the SAME ordered chain resolveWorkerPlacement " +
        "applies — opt-in, profile allowlist, eligible worker, branch, repoPath, repository shape — " +
        "against live state, names the check that decided, and shows the values it read. Board machine only.",
    )
    .option("--board <url>", "Board base URL", DEFAULT_BOARD_URL)
    .option("--project <projectId>", "Project id (defaults to the board's active project)")
    .option("--provider <name>", "Provider to resolve for (defaults to what this project's next launch would use)")
    .option("--json", "Output raw JSON")
    .action(async (issue: string, options: { board: string; project?: string; provider?: string; json?: boolean }) => {
      const params = new URLSearchParams({ issue });
      if (options.project) params.set("projectId", options.project);
      if (options.provider) params.set("provider", options.provider);
      const res = await fetch(`${options.board.replace(/\/+$/, "")}/api/workers/explain?${params}`);
      const body = (await res.json()) as IssuePlacementReport | { error: string };
      if (!res.ok || "error" in body) {
        console.error("error" in body ? body.error : `request failed (${res.status})`);
        process.exit(1);
      }
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      console.log(renderPlacementExplanation(body));
      // A disagreement is a defect in the EXPLANATION, not in the placement, so it
      // must not read as a successful answer.
      if (!body.explanation.agreesWithResolver) process.exit(1);
    });

  workerCmd
    .command("placements")
    .description(
      "Which machine each recent session actually ran on (host, or a named worker). Board machine only.",
    )
    .option("--board <url>", "Board base URL", DEFAULT_BOARD_URL)
    .option("--project <projectId>", "Restrict to one project")
    .option("--worker <workerId>", "Restrict to one worker")
    .option("--remote-only", "Only sessions that ran on a worker")
    .option("--limit <n>", "How many sessions to list", "20")
    .option("--json", "Output raw JSON")
    .action(async (options: {
      board: string;
      project?: string;
      worker?: string;
      remoteOnly?: boolean;
      limit: string;
      json?: boolean;
    }) => {
      const params = new URLSearchParams({ limit: options.limit });
      if (options.project) params.set("projectId", options.project);
      if (options.worker) params.set("workerId", options.worker);
      if (options.remoteOnly) params.set("remoteOnly", "true");
      const res = await fetch(`${options.board.replace(/\/+$/, "")}/api/workers/placements?${params}`);
      if (!res.ok) {
        console.error(`Failed to list placements (${res.status}). Is the board running at ${options.board}?`);
        process.exit(1);
      }
      const body = (await res.json()) as { placements: SessionPlacementRecord[] };
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      if (body.placements.length === 0) {
        console.log("No sessions found.");
        return;
      }
      for (const p of body.placements) {
        // A revoked worker keeps its id on the session: "ran remotely on a worker that
        // no longer exists" must stay distinguishable from "ran on the host".
        const where = p.placement === "remote" ? `worker ${p.workerName ?? `${p.workerId} (revoked)`}` : "host";
        const issue = p.issueNumber === null ? "" : ` #${p.issueNumber}`;
        console.log(`  ${p.startedAt}${issue} ${p.executor} [${p.status}] on ${where}`);
      }
    });
  // #774 (remaining #755 item 4) — TWO commands, not one, and the split is forced rather
  // than stylistic: docs/worker-fleet.md §1 says a worker machine "genuinely cannot ask the
  // board how it looks from there", because every owner route is mounted only on the
  // loopback board app. A single `doctor` claiming to check both ends would have to lie
  // about one of them.
  workerCmd
    .command("doctor")
    .description(
      "Run ON THE WORKER MACHINE: self-test the whole chain to the board — fleet port reachable, " +
        "the saved pairing still authenticates, the WebSocket upgrade survives whatever is in " +
        "between, the git transport port answers, git on PATH, and each provider CLI installed AND " +
        "logged in HERE (the board never sends credentials). Exits non-zero if any check fails.",
    )
    .option("--board <url>", "Board base URL — the FLEET port on a cross-machine setup", DEFAULT_BOARD_URL)
    .option("--providers <csv>", "Provider CLIs to check on this machine", "claude")
    .option("--git-port <n>", "KANBAN_GIT_HTTP_PORT, to check the git transport too", (v) => parseInt(v, 10))
    .option("--state-file <path>", `Pairing state file (default: ${defaultWorkerStateFile()})`)
    .option("--json", "Output the report as JSON")
    .action(async (options: {
      board: string;
      providers: string;
      gitPort?: number;
      stateFile?: string;
      json?: boolean;
    }) => {
      const report = await runWorkerDoctor({
        boardUrl: options.board,
        stateFile: options.stateFile ?? defaultWorkerStateFile(),
        providers: splitList(options.providers) ?? ["claude"],
        ...(options.gitPort === undefined || Number.isNaN(options.gitPort) ? {} : { gitPort: options.gitPort }),
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
      // Non-zero on failure so this is usable from the Windows scheduled task and from a
      // pairing script, not just by eye.
      if (!report.ok) process.exit(1);
    });

  workerCmd
    .command("doctor-board")
    .description(
      "Run ON THE BOARD MACHINE: the other half of `worker doctor`. Reports what the board SEES of " +
        "each worker — online, socket held, eligible for the resolved provider/labels, free slots — " +
        "and names the state that is hardest to spot from either side alone: a worker whose heartbeat " +
        "is fresh but whose WebSocket the board does not hold.",
    )
    .option("--board <url>", "Board API base URL (loopback only)", DEFAULT_BOARD_URL)
    .option("--project <projectId>", "Resolve required labels from this project's worker_labels_<id>")
    .option("--provider <name>", "Provider to judge eligibility for (default: claude)")
    .option("--json", "Output the report as JSON")
    .action(async (options: { board: string; project?: string; provider?: string; json?: boolean }) => {
      const report = await runBoardDoctor({
        boardUrl: options.board,
        ...(options.project ? { projectId: options.project } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
      if (!report.ok) process.exit(1);
    });

  workerCmd
    .command("events <workerId>")
    .description(
      "The board's recorded timeline for one worker (#774): registration, protocol mismatches and " +
        "incoming-ref decisions, newest first. Board machine only. Before this existed a fleet " +
        "failure had to be reconstructed from the server console, which a restart discards.",
    )
    .option("--board <url>", "Board base URL", DEFAULT_BOARD_URL)
    .option("--limit <n>", "How many events to list", "50")
    .option("--json", "Output raw JSON")
    .action(async (workerId: string, options: { board: string; limit: string; json?: boolean }) => {
      const url = `${options.board.replace(/\/+$/, "")}/api/workers/${workerId}/events?limit=${encodeURIComponent(options.limit)}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`Failed to list events (${res.status}). Is the board running at ${options.board}?`);
        process.exit(1);
      }
      const body = (await res.json()) as {
        events: Array<{ createdAt: string; type: string; summary: string; sessionId: string | null }>;
      };
      if (options.json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      if (body.events.length === 0) {
        console.log("No events recorded for this worker.");
        return;
      }
      for (const e of body.events) {
        const session = e.sessionId ? ` session=${e.sessionId}` : "";
        console.log(`  ${e.createdAt} [${e.type}] ${e.summary}${session}`);
      }
    });
}
