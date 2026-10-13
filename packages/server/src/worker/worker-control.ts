// #1355 — the running daemon's local control endpoint, and the client `update-check --apply` uses.
//
// WHY. A worker operator had no way to ask THEIR daemon to update: `worker update <name>` is
// board-side, and the only lever left was killing the daemon. The update machinery (drain, verify,
// install, relaunch) lives inside the daemon, so the verb must reach that process rather than start
// a second one. The daemon therefore listens on a loopback ephemeral port and publishes
// `worker-control.json` beside the state file ({port, pid, token, boardUrl}); the CLI reads it.
//
// Loopback only + a per-start random token in a file only this user can read: the endpoint can make
// the daemon drain and restart, so it must not answer to other local users or the network.
// Db-free (node:http/fs only): this module ships in the standalone worker binary.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { parseBuildId, sameBuild, type WorkerUpdateReport } from "../lib/worker-update.js";

export interface WorkerControlFile {
  port: number;
  pid: number;
  token: string;
  boardUrl: string;
  /** The running daemon's own build version (may be undefined for an unstamped build). */
  workerVersion?: string;
}

export type UpdateNowResult =
  | { result: "current"; from?: string; to?: string }
  | { result: "started"; from?: string; to?: string }
  | { result: "in-progress"; from?: string; to?: string }
  | { result: "failed"; from?: string; to?: string; phase?: string; reason: string };

export interface WorkerControlStatus {
  pid: number;
  boardUrl: string;
  workerVersion?: string;
  update: WorkerUpdateReport;
  /** #1443: lifecycle view, merged in by the daemon (see worker-lifecycle.ts). */
  draining?: boolean;
  sessionsLeft?: number;
  /** Phase of the last recorded update failure (`manifest`, `download`, `install`, …). */
  failurePhase?: string;
}

export interface WorkerControlHandlers {
  updateNow(): Promise<UpdateNowResult>;
  status(): WorkerControlStatus;
  /** #1443: extra fields for `status` (effective settings, state file, work root, ...). */
  details?(): Record<string, unknown>;
  /** #1443: stop or restart the daemon, optionally after draining. Answers at once; the work runs on. */
  shutdown?(req: { restart: boolean; drain: boolean }): ShutdownAck;
}

export type ShutdownAck =
  | { ok: true; sessionsLeft: number; drain: boolean; restart: boolean }
  | { ok: false; reason: string };

export function controlFileFor(stateFile: string): string {
  return join(dirname(stateFile), "worker-control.json");
}

export function readControlFile(stateFile: string): WorkerControlFile | null {
  try {
    const raw = JSON.parse(readFileSync(controlFileFor(stateFile), "utf8")) as Partial<WorkerControlFile>;
    if (typeof raw.port !== "number" || typeof raw.token !== "string" || typeof raw.pid !== "number") return null;
    return raw as WorkerControlFile;
  } catch {
    return null;
  }
}

export interface WorkerControlServer {
  port: number;
  close(): Promise<void>;
}

export async function startWorkerControlServer(opts: {
  stateFile: string;
  boardUrl: string;
  workerVersion?: string;
  handlers: WorkerControlHandlers;
  log: (line: string) => void;
}): Promise<WorkerControlServer | null> {
  const token = randomBytes(24).toString("hex");
  const send = (res: import("node:http").ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.headers["x-worker-control-token"] !== token) return send(res, 401, { error: "bad control token" });
      try {
        if (req.method === "GET" && req.url === "/status") return send(res, 200, { ...opts.handlers.status(), ...(opts.handlers.details?.() ?? {}) });
        if (req.method === "POST" && req.url?.startsWith("/shutdown")) {
          if (!opts.handlers.shutdown) return send(res, 501, { error: "this daemon cannot stop or restart itself" });
          const q = new URL(req.url, "http://127.0.0.1").searchParams;
          return send(res, 200, opts.handlers.shutdown({ restart: q.get("restart") === "1", drain: q.get("drain") === "1" }));
        }
        if (req.method === "POST" && req.url === "/update") return send(res, 200, await opts.handlers.updateNow());
        send(res, 404, { error: "not found" });
      } catch (err) {
        send(res, 500, { error: errorMessage(err) });
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    // The control endpoint is a convenience: a daemon that cannot open it must still work.
    opts.log(`[worker] control endpoint unavailable (continuing): ${errorMessage(err)}`);
    return null;
  }
  const port = (server.address() as { port: number }).port;
  const file = controlFileFor(opts.stateFile);
  const payload: WorkerControlFile = { port, pid: process.pid, token, boardUrl: opts.boardUrl, workerVersion: opts.workerVersion };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  } catch (err) {
    opts.log(`[worker] could not write ${file} (continuing): ${errorMessage(err)}`);
  }
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Only remove the file if it is still ours — a successor daemon may already have replaced it.
        if (readControlFile(opts.stateFile)?.pid === process.pid) {
          try { rmSync(file, { force: true }); } catch { /* best effort */ }
        }
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// --- client ---------------------------------------------------------------------------------

async function call<T>(ctl: WorkerControlFile, method: "GET" | "POST", path: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(`http://127.0.0.1:${ctl.port}${path}`, {
    method,
    headers: { "x-worker-control-token": ctl.token },
  });
  if (!res.ok) throw new Error(`control endpoint answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface ApplyUpdateOptions {
  stateFile: string;
  print: (line: string) => void;
  /** Give up waiting for the restart after this long (drain waits for running sessions). 0 = look once (--no-wait, #1443). */
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** A build id shown the same way on both sides of "updated from X to Y" (#1360): 7-char short sha. */
function shortBuild(id: string | undefined): string {
  if (!id) return "?";
  return /^[0-9a-f]{7,40}$/i.test(id) ? id.slice(0, 7) : id;
}

/** #1443: what `update-check --apply` prints when the wait ends mid-drain: progress, not a failure. */
export function drainInProgressMessage(sessionsLeft: number | undefined): string {
  return `drain in progress, ${sessionsLeft ?? "?"} session(s) left; check with: agentic-kanban-worker status`;
}

/** Exit-code-shaped outcome of `update-check --apply`. */
export interface ApplyUpdateOutcome {
  ok: boolean;
  summary: string;
}

/**
 * Ask the running daemon (found via the state file's control file) to update to the board's build,
 * then follow it until it is done: already current / updated from X to Y / failed in <phase>: <cause>.
 */
export async function applyWorkerUpdate(o: ApplyUpdateOptions): Promise<ApplyUpdateOutcome> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 1000;
  const timeoutMs = o.timeoutMs ?? 10 * 60 * 1000;
  const fail = (summary: string): ApplyUpdateOutcome => ({ ok: false, summary });

  const ctl = readControlFile(o.stateFile);
  if (!ctl) {
    return fail(
      `no running worker daemon found (no ${controlFileFor(o.stateFile)}). Start it with ` +
        "'agentic-kanban-worker start' - a daemon that predates #1355 has no control endpoint either; " +
        "restart it once through the stable shim.",
    );
  }
  let first: UpdateNowResult;
  try {
    first = await call<UpdateNowResult>(ctl, "POST", "/update", fetchImpl);
  } catch (err) {
    return fail(`the daemon (pid ${ctl.pid}) did not answer on 127.0.0.1:${ctl.port} (${errorMessage(err)}); it is not running or was replaced.`);
  }
  o.print(`Asked the running daemon (pid ${ctl.pid}, board ${ctl.boardUrl}) for the board's build.`);
  if (first.result === "current") return { ok: true, summary: `already current (build ${first.from ?? "?"})` };
  if (first.result === "failed") {
    return fail(`failed in ${first.phase ?? "update"}: ${first.reason}`);
  }
  const from = first.from;
  const to = first.to;
  o.print(
    first.result === "in-progress"
      ? `An update to ${to ?? "the board's build"} is already in progress; following it.`
      : `Updating ${from ?? "?"} -> ${to ?? "?"}: the daemon drains (running sessions finish first), downloads, verifies, installs and restarts.`,
  );

  const deadline = Date.now() + timeoutMs;
  let lastReason = "";
  let current = ctl;
  let lastStatus: WorkerControlStatus | undefined;
  let polled = false;
  while (!polled || Date.now() < deadline) {
    polled = true; // a no-wait run still looks once
    await sleep(pollMs);
    const latest = readControlFile(o.stateFile) ?? current;
    let status: WorkerControlStatus;
    try {
      status = await call<WorkerControlStatus>(latest, "GET", "/status", fetchImpl);
    } catch {
      // The daemon is mid-restart (or its successor has not published yet): keep polling.
      current = latest;
      continue;
    }
    current = latest;
    lastStatus = status;
    if (latest.token !== ctl.token) {
      // A new daemon start answers (its token is fresh per start): the restart happened.
      const now = status.workerVersion;
      if (sameBuild(parseBuildId(now), to)) {
        return { ok: true, summary: `updated from ${shortBuild(from)} to ${shortBuild(parseBuildId(now) ?? now)}` };
      }
      if (status.update.state === "failed") {
        return fail(`failed in ${status.failurePhase ?? "update"}: ${status.update.reason ?? "unknown"} (now running ${now ?? "?"})`);
      }
      return fail(`the daemon restarted on ${now ?? "?"}, not on the board's build ${to ?? "?"} (it may have rolled back; see worker.log)`);
    }
    if (status.update.state === "failed") {
      return fail(`failed in ${status.failurePhase ?? "update"}: ${status.update.reason ?? "unknown"}`);
    }
    if (status.update.state === "updating" && status.update.reason && status.update.reason !== lastReason) {
      lastReason = status.update.reason;
      o.print(`  ${lastReason}`);
    }
    if (status.update.state === "current") {
      return { ok: true, summary: `already current (build ${status.workerVersion ?? "?"})` };
    }
  }
  // #1443: a drain still waiting on sessions is progress, not a failure.
  if (lastStatus?.update.state === "updating") return { ok: true, summary: drainInProgressMessage(lastStatus.sessionsLeft) };
  return fail(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the daemon to finish updating; it may still be draining (check worker.log)`);
}

/** #1443: `stop` / `restart` — ask the running daemon to shut down (optionally after draining). */
export async function requestWorkerShutdown(o: {
  stateFile: string;
  restart: boolean;
  drain: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; pid: number; ack: Extract<ShutdownAck, { ok: true }> } | { ok: false; reason: string }> {
  const ctl = readControlFile(o.stateFile);
  if (!ctl) return { ok: false, reason: `no running worker daemon found (no ${controlFileFor(o.stateFile)})` };
  try {
    const res = await (o.fetchImpl ?? fetch)(`http://127.0.0.1:${ctl.port}/shutdown?restart=${o.restart ? 1 : 0}&drain=${o.drain ? 1 : 0}`, {
      method: "POST",
      headers: { "x-worker-control-token": ctl.token },
    });
    if (!res.ok) return { ok: false, reason: `control endpoint answered HTTP ${res.status}` };
    const ack = (await res.json()) as ShutdownAck;
    return ack.ok ? { ok: true, pid: ctl.pid, ack } : { ok: false, reason: ack.reason };
  } catch (err) {
    return { ok: false, reason: `the daemon (pid ${ctl.pid}) did not answer on 127.0.0.1:${ctl.port} (${errorMessage(err)})` };
  }
}

/** #1443: the daemon's `/status` including the lifecycle details; null when no daemon answers. */
export async function fetchWorkerStatus(stateFile: string, fetchImpl: typeof fetch = fetch): Promise<(WorkerControlStatus & Record<string, unknown>) | null> {
  const ctl = readControlFile(stateFile);
  if (!ctl) return null;
  try {
    return await call<WorkerControlStatus & Record<string, unknown>>(ctl, "GET", "/status", fetchImpl);
  } catch {
    return null;
  }
}
