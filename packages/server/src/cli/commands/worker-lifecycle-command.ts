// #1443 — `status`, `stop`, `restart`, `config` for the running worker daemon, plus the daemon-side
// stop/restart handler `worker start` hands to the control endpoint. Db-free: part of the standalone
// worker binary (worker-cli-isolation.test.ts).

import type { Command } from "commander";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { defaultWorkerStateFile, type WorkerDaemonHandle } from "../../worker/worker-daemon.js";
import { fetchWorkerStatus, readControlFile, requestWorkerShutdown } from "../../worker/worker-control.js";
import {
  START_CONFIG_KEYS,
  buildLifecycleDetails,
  loadStartConfig,
  renderStatus,
  setStartConfig,
  unsetStartConfig,
  type LifecycleCtx,
  type LifecycleHandlers,
} from "../../worker/worker-lifecycle.js";
import { relaunchWorker } from "../../worker/worker-updater.js";
import { cliPathArg } from "../cli-path.js";

/** `90`, `90s`, `10m`, `2h` -> milliseconds; null when it is none of those. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(raw.trim());
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h"];
  return Math.round(Number(m[1]) * unit);
}

/** `update-check --apply --wait <dur> | --no-wait` -> the `timeoutMs` option (none = the default wait). */
export function waitOption(wait: string | false | undefined): { timeoutMs?: number } {
  if (wait === undefined) return {};
  if (wait === false) return { timeoutMs: 0 };
  const ms = parseDuration(wait);
  if (ms === null) {
    console.error(`--wait: '${wait}' is not a duration (use e.g. 90s, 10m, 2h)`);
    process.exit(2);
  }
  return { timeoutMs: ms };
}

/** The daemon side: what `worker start` plugs into `startWorkerDaemon({ lifecycle })`. */
export function createLifecycle(d: {
  getDaemon(): WorkerDaemonHandle | undefined;
  entry: string | null;
  argv: string[];
  logFile: string;
  leaveAgents?: boolean;
  isSupervised: boolean;
  onStopped(): void;
}): (ctx: LifecycleCtx) => LifecycleHandlers {
  return (ctx) => {
    let started = false;
    return {
      details: () => buildLifecycleDetails(ctx),
      shutdown({ restart, drain }) {
        const daemon = d.getDaemon();
        if (started) return { ok: false, reason: "a stop/restart is already in progress" };
        if (!daemon) return { ok: false, reason: "the daemon is still starting; retry in a moment" };
        if (restart && !d.entry) return { ok: false, reason: "cannot locate this install's bin/worker.js, so it cannot restart itself" };
        started = true;
        void (async () => {
          try {
            if (drain) {
              await daemon.drain();
              while (ctx.sessionsLeft() > 0) await new Promise((r) => setTimeout(r, 2000));
            }
            await daemon.stop({ killAgents: !drain && !d.leaveAgents, drainTimeoutMs: 10_000 });
          } catch {
            /* the handover matters more than a tidy close */
          }
          d.onStopped();
          if (restart && d.entry) {
            relaunchWorker(d.entry, { argv: d.argv, execPath: process.execPath, supervised: d.isSupervised, logFile: d.logFile, exit: (code) => process.exit(code) });
          } else {
            process.exit(0);
          }
        })();
        return { ok: true, sessionsLeft: ctx.sessionsLeft(), drain, restart };
      },
    };
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the control file until the daemon is gone (stop) or replaced (restart). */
async function waitForHandover(stateFile: string, before: { pid: number; token: string }, restart: boolean, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const now = readControlFile(stateFile);
    if (restart ? now && now.token !== before.token : !now) return now ? `restarted (pid ${now.pid})` : "stopped";
  }
  return null;
}

export function registerWorkerLifecycle(workerCmd: Command): void {
  const stateOpt = ["--state-file <path>", `Pairing state file, relative to the directory you run the command in (default: ${defaultWorkerStateFile()})`, cliPathArg] as const;

  workerCmd
    .command("status")
    .description(
      "Run ON THE WORKER MACHINE (#1443): ask the running daemon for its build, drain state, sessions left, " +
        "the effective settings and which of them a start flag or `config set` pins, plus the state file and work root.",
    )
    .option(...stateOpt)
    .option("--json", "Output the status as JSON")
    .action(async (options: { stateFile?: string; json?: boolean }) => {
      const stateFile = options.stateFile ?? defaultWorkerStateFile();
      const status = await fetchWorkerStatus(stateFile);
      if (!status) {
        console.error(`no running worker daemon found for ${stateFile}. Start it with 'agentic-kanban-worker start'.`);
        process.exit(1);
      }
      console.log(options.json ? JSON.stringify(status, null, 2) : renderStatus(status));
    });

  for (const verb of ["stop", "restart"] as const) {
    const restart = verb === "restart";
    workerCmd
      .command(verb)
      .description(
        `Run ON THE WORKER MACHINE (#1443): ${verb} the running daemon (found through the state file) — no manual node-pid kill. ` +
          `With --drain it first stops taking new sessions and waits for the running ones, then ${verb}s; without it, running agents are killed like Ctrl+C.`,
      )
      .option("--drain", `Let running sessions finish before the ${verb} (returns at once; follow with 'status')`)
      .option(...stateOpt)
      .action(async (options: { drain?: boolean; stateFile?: string }) => {
        const stateFile = options.stateFile ?? defaultWorkerStateFile();
        const before = readControlFile(stateFile);
        const r = await requestWorkerShutdown({ stateFile, restart, drain: options.drain === true });
        if (!r.ok || !before) {
          console.error(r.ok ? "no running worker daemon found" : r.reason);
          process.exit(1);
        }
        if (options.drain && r.ack.sessionsLeft > 0) {
          console.log(`drain in progress, ${r.ack.sessionsLeft} session(s) left; the worker ${verb}s when they finish; check with: agentic-kanban-worker status`);
          return;
        }
        const result = await waitForHandover(stateFile, before, restart, 60_000);
        if (!result) {
          console.error(`the daemon (pid ${before.pid}) was asked to ${verb} but has not finished after 60s; check with: agentic-kanban-worker status`);
          process.exit(1);
        }
        console.log(result);
      });
  }

  workerCmd
    .command("config <action> [key] [value]")
    .description(
      "Edit the worker's persisted start args (#1443). `config set <key> <value>` pins a setting, `config unset <key>` " +
        "drops its pin (the board's value applies again), `config show` lists them. Keys: " +
        `${START_CONFIG_KEYS.join(", ")}. Applied on the next (self-)restart — e.g. 'config unset maxConcurrency' then 'restart --drain'.`,
    )
    .option(...stateOpt)
    .action((action: string, key: string | undefined, value: string | undefined, options: { stateFile?: string }) => {
      const stateFile = options.stateFile ?? defaultWorkerStateFile();
      try {
        if (action === "show") {
          const cfg = loadStartConfig(stateFile);
          console.log(JSON.stringify(cfg, null, 2));
          return;
        }
        if (action !== "set" && action !== "unset") throw new Error(`unknown action '${action}' (set, unset or show)`);
        if (!key) throw new Error(`config ${action} needs a key (one of: ${START_CONFIG_KEYS.join(", ")})`);
        const err = action === "set" ? setStartConfig(stateFile, key, value) : unsetStartConfig(stateFile, key);
        if (err) throw new Error(err);
        console.log(`${action} ${key}${action === "set" ? ` ${value}` : ""}: saved in ${stateFile}; takes effect on the next restart ('agentic-kanban-worker restart --drain')`);
      } catch (err) {
        console.error(errorMessage(err));
        process.exit(1);
      }
    });
}
