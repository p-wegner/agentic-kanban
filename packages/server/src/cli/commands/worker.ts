import type { Command } from "commander";
import { startWorkerDaemon, defaultWorkerStateFile } from "../../worker/worker-daemon.js";
import { SHARES_FILESYSTEM_LABEL } from "@agentic-kanban/shared/lib/worker-protocol";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

const DEFAULT_BOARD_URL = "http://127.0.0.1:3001";

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
        "the registry's plain `0.1.9` means npm served a cached copy instead of your file.",
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
    .description("Fleet worker: connect this machine to a board and execute assigned agent sessions.\n\nSubcommands: pair, start, instructions, list");
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
    }) => {
      try {
        const labels = splitList(options.labels) ?? [];
        if (options.sharesFilesystem && !labels.includes(SHARES_FILESYSTEM_LABEL)) {
          labels.push(SHARES_FILESYSTEM_LABEL);
        }
        const daemon = await startWorkerDaemon({
          boardUrl: options.board,
          pairingToken: options.token,
          name: options.name,
          labels: labels.length > 0 ? labels : undefined,
          providers: splitList(options.providers),
          maxConcurrency: options.maxConcurrency,
          stateFile: options.stateFile,
          workRoot: options.workRoot,
        });
        // The reconnect timers are unref'd; this keeps the CLI process alive.
        const keepAlive = setInterval(() => {}, 60_000);
        const shutdown = () => {
          console.log("\n[worker] shutting down" + (options.leaveAgents ? " (leaving agents running)" : ""));
          clearInterval(keepAlive);
          daemon.stop({ killAgents: !options.leaveAgents });
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      } catch (err) {
        console.error(errorMessage(err));
        process.exit(1);
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
      const body = await res.json() as { workers: Array<{ id: string; name: string; effectiveStatus: string; status: string; os: string | null; labels: string | null; maxConcurrency: number; lastHeartbeatAt: string | null }> };
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
        console.log(`  ${w.name} [${w.effectiveStatus}] id=${w.id} os=${w.os ?? "?"} maxConcurrency=${w.maxConcurrency}${labels} lastHeartbeat=${w.lastHeartbeatAt ?? "never"}`);
      }
    });
}
