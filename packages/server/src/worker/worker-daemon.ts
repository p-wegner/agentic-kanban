// Fleet worker daemon (epic #1, phase 1b #4).
//
// Pull model: the worker dials the board — REST to register (pairing token →
// per-worker token, persisted locally) and heartbeat, a WebSocket for
// assignments and output streaming. Socket loss never kills running agents:
// the daemon keeps them, reconnects with backoff, re-announces them via
// `hello`, and queues exit/assign_failed messages while offline so session
// finalization is never lost (stdout/stderr during a gap is dropped in this
// phase). Credentials stay worker-local: the daemon runs agents with this
// machine's own logins and never receives board credentials.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import {
  parseBoardToWorkerMessage,
  type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { createWorkerAgentRunner } from "./worker-agent-runner.js";

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;
/** Bounded queue of undeliverable-but-critical messages (exit/assign_failed). */
const PENDING_QUEUE_CAP = 200;

export interface WorkerDaemonOptions {
  boardUrl: string;
  /** Required for first registration against this board; ignored once paired. */
  pairingToken?: string;
  name?: string;
  labels?: string[];
  providers?: string[];
  maxConcurrency?: number;
  /** Defaults to ~/.agentic-kanban/worker-state.json. */
  stateFile?: string;
  /** Root for git-transport clones/checkouts. Defaults to ~/.agentic-kanban/worker. */
  workRoot?: string;
  heartbeatIntervalMs?: number;
  log?: (line: string) => void;
}

interface WorkerIdentity {
  workerId: string;
  workerToken: string;
  name: string;
}

interface WorkerStateFile {
  boards: Record<string, WorkerIdentity>;
}

export function defaultWorkerStateFile(): string {
  return join(homedir(), ".agentic-kanban", "worker-state.json");
}

function normalizeBoardUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function loadState(stateFile: string): WorkerStateFile {
  try {
    if (existsSync(stateFile)) {
      return JSON.parse(readFileSync(stateFile, "utf8")) as WorkerStateFile;
    }
  } catch {
    /* corrupt state — re-register */
  }
  return { boards: {} };
}

function saveIdentity(stateFile: string, boardUrl: string, identity: WorkerIdentity): void {
  const state = loadState(stateFile);
  state.boards[boardUrl] = identity;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function registerWithBoard(opts: WorkerDaemonOptions, boardUrl: string, name: string): Promise<WorkerIdentity> {
  if (!opts.pairingToken) {
    throw new Error(
      `Worker is not paired with ${boardUrl} and no --token was given. ` +
      `Mint one on the board (POST /api/workers/pairing-token or 'worker pair') and pass it via --token.`,
    );
  }
  const res = await fetch(`${boardUrl}/api/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingToken: opts.pairingToken,
      name,
      os: platform(),
      arch: arch(),
      labels: opts.labels,
      providers: opts.providers,
      maxConcurrency: opts.maxConcurrency,
    }),
  });
  const body = await res.json().catch(() => ({})) as { workerId?: string; workerToken?: string; error?: string };
  if (!res.ok || !body.workerId || !body.workerToken) {
    throw new Error(`Registration failed (${res.status}): ${body.error ?? "unexpected response"}`);
  }
  return { workerId: body.workerId, workerToken: body.workerToken, name };
}

export interface WorkerDaemonHandle {
  workerId: string;
  /** Resolves once the first WS connection is established. */
  connected: Promise<void>;
  stop(opts?: { killAgents?: boolean }): void;
}

export async function startWorkerDaemon(opts: WorkerDaemonOptions): Promise<WorkerDaemonHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const boardUrl = normalizeBoardUrl(opts.boardUrl);
  const stateFile = opts.stateFile ?? defaultWorkerStateFile();
  const name = opts.name ?? hostname();

  let identity = loadState(stateFile).boards[boardUrl];
  if (!identity) {
    identity = await registerWithBoard(opts, boardUrl, name);
    saveIdentity(stateFile, boardUrl, identity);
    log(`[worker] registered with ${boardUrl} as '${identity.name}' (id=${identity.workerId})`);
  } else {
    log(`[worker] resuming pairing with ${boardUrl} as '${identity.name}' (id=${identity.workerId})`);
  }

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  const pendingCritical: WorkerToBoardMessage[] = [];

  const sendToBoard = (message: WorkerToBoardMessage): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
      return;
    }
    // Exit/assign_failed must eventually reach the board or the session hangs
    // "running" forever; live output during a gap is droppable.
    if (message.type !== "event" || message.event.type === "exit") {
      if (pendingCritical.length < PENDING_QUEUE_CAP) pendingCritical.push(message);
    }
  };

  // maxConcurrency is passed to the runner as well as to register (#266): the board
  // tracking capacity protects a well-behaved board, but the ceiling is this machine
  // owner's, so the worker enforces it locally instead of trusting the assigner.
  const runner = createWorkerAgentRunner(sendToBoard, {
    boardUrl,
    workRoot: opts.workRoot,
    maxConcurrency: opts.maxConcurrency,
  });

  let resolveConnected!: () => void;
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });

  function connect(): void {
    if (stopped) return;
    const wsUrl = `${boardUrl.replace(/^http/, "ws")}/ws/workers/${identity.workerId}`;
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${identity.workerToken}` },
    });
    ws = socket;

    socket.on("open", () => {
      reconnectDelay = RECONNECT_MIN_MS;
      log(`[worker] connected to ${boardUrl}`);
      socket.send(JSON.stringify({
        type: "hello",
        workerId: identity.workerId,
        runningSessionIds: runner.runningSessionIds(),
      } satisfies WorkerToBoardMessage));
      while (pendingCritical.length > 0) {
        socket.send(JSON.stringify(pendingCritical.shift()));
      }
      resolveConnected();
    });

    socket.on("message", (data) => {
      // `data` is ws's RawData: Buffer | ArrayBuffer | Buffer[]. A bare `.toString()` on the
      // array case yields comma-joined garbage rather than the frame (no-base-to-string).
      const raw = Array.isArray(data)
        ? Buffer.concat(data as readonly Uint8Array[])
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(new Uint8Array(data as ArrayBuffer));
      const message = parseBoardToWorkerMessage(raw.toString("utf8"));
      if (!message) {
        log(`[worker] dropping malformed board message`);
        return;
      }
      switch (message.type) {
        case "assign":
          if (message.repo) runner.assignWithRepo(message.sessionId, message.spec, message.repo);
          else runner.assign(message.sessionId, message.spec);
          break;
        case "input":
          runner.input(message.sessionId, message.data);
          break;
        case "close_stdin":
          runner.closeStdin(message.sessionId);
          break;
        case "stop":
          runner.stop(message.sessionId);
          break;
      }
    });

    const scheduleReconnect = () => {
      if (stopped) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      log(`[worker] disconnected; retrying in ${Math.round(delay / 1000)}s`);
      const timer = setTimeout(connect, delay);
      if (timer.unref) timer.unref();
    };

    socket.on("close", () => {
      if (ws === socket) ws = null;
      scheduleReconnect();
    });
    socket.on("error", (err) => {
      log(`[worker] socket error: ${err.message}`);
      // 'close' follows and schedules the reconnect.
    });
  }

  connect();

  const heartbeatTimer = setInterval(() => {
    void fetch(`${boardUrl}/api/workers/${identity.workerId}/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${identity.workerToken}`,
      },
      body: JSON.stringify({}),
    }).catch(() => { /* board unreachable — WS reconnect handles visibility */ });
  }, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  return {
    workerId: identity.workerId,
    connected,
    stop(stopOpts) {
      stopped = true;
      clearInterval(heartbeatTimer);
      if (stopOpts?.killAgents) runner.stopAll();
      try { ws?.close(); } catch { /* already closed */ }
      ws = null;
    },
  };
}
