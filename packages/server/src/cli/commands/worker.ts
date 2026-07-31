import type { Command } from "commander";
import { startWorkerDaemon, defaultWorkerStateFile } from "../../worker/worker-daemon.js";
import { SHARES_FILESYSTEM_LABEL } from "../../services/worker-fleet.service.js";

const DEFAULT_BOARD_URL = "http://127.0.0.1:3001";

function splitList(value?: string): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
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
    .description("Fleet worker: connect this machine to a board and execute assigned agent sessions.\n\nSubcommands: pair, start, list");

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
      console.log(`  agentic-kanban worker start --board <board-url> --token ${body.pairingToken}`);
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
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
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
