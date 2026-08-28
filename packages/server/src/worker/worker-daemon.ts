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
//
// #754 — THIS IS A LONG-RUNNING PROCESS ON SOMEONE ELSE'S MACHINE, so every
// shutdown and every unrecoverable error is a data-loss bug until it is handled:
//
//  * `stop()` is ASYNC and DRAINS. It used to be sync and the CLI called
//    `process.exit(0)` immediately after, so with `--kill-agents` the process was
//    gone before `proc.on("exit")` → `emitExit` → `pushWorkerResult` could run:
//    completed work was never pushed and the board learned about it via the 60 s
//    grace, i.e. as a failure. Now: announce `draining` so the board stops
//    assigning, stop accepting, then wait (bounded) for in-flight pushes and
//    flush the critical queue before the socket closes.
//  * `draining` is now actually SET. It was a declared status honoured by
//    `eligibleWorkers` and coloured by the panel that nothing ever wrote, so the
//    only way out of rotation was revoke — which kills in-flight tokens.
//  * A 401 is FATAL, not a retry. A revoked/forgotten worker used to reconnect
//    every 30 s forever with a red tray and nothing in any log explaining it,
//    while the identity in worker-state.json blocked re-pairing even with a fresh
//    `--token`. Now a 401 either re-registers (when a `--token` is present) or
//    exits non-zero with the reason.
//  * Capabilities ride every heartbeat, not just first registration.
//  * `hello` and `register` carry a protocol version; an incompatible board
//    refuses with a sentence instead of failing as a silence.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  parseBoardToWorkerMessage,
  WORKER_PROTOCOL_VERSION,
  WORKER_UPDATE_REMEDIATION,
  type WorkerCapabilities,
  type WorkerCapacityInfo,
  type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { readTier0Capacity, toWorkerCapacitySnapshot } from "@agentic-kanban/shared/lib/machine-capacity";
import { createWorkerAgentRunner } from "./worker-agent-runner.js";
import { defaultWorkerWorkRoot, reapOrphanedCheckouts } from "./worker-repo.js";
import { attestProviderAuth } from "../cli/commands/worker-doctor.js";

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30 * 1000;
/** Bounded queue of undeliverable-but-critical messages (exit/assign_failed). */
const PENDING_QUEUE_CAP = 200;

/**
 * Default ceiling on a drain (#754). Long enough for a `git push` of a normal result over
 * a slow link, short enough that Ctrl+C still feels like Ctrl+C. Past it the daemon exits
 * and says exactly what it abandoned rather than hanging on a push that may never finish.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 1000;

/**
 * How many times a 401 may be answered by re-pairing before the daemon gives up (#754).
 *
 * Found by the test for this ticket: without a bound, "re-register on 401" is just a
 * faster version of the forever-loop it replaced — a board that hands out a token and then
 * rejects it produced 940 registrations in two minutes. A pairing token is single-use, so
 * the honest number is small: the FIRST re-pairing is the recovery, and anything past it
 * means the board is refusing this machine for a reason a new token cannot fix.
 */
export const MAX_REPAIR_ATTEMPTS = 2;

export interface WorkerDaemonOptions {
  boardUrl: string;
  /** Required for first registration against this board; ignored once paired. */
  pairingToken?: string;
  name?: string;
  labels?: string[];
  providers?: string[];
  /**
   * Verify each declared provider can actually authenticate on THIS machine (#895) before
   * advertising it to the board, narrowing `providers` down to what `checkProvider` can
   * prove. Default true. Set false only when a provider is known-authenticated purely via
   * an env API key the doctor check cannot see (its "unknown" case) — this is the
   * operator asserting that a false negative, not a real gap.
   */
  attestProviders?: boolean;
  maxConcurrency?: number;
  /** Defaults to ~/.agentic-kanban/worker-state.json. */
  stateFile?: string;
  /** Root for git-transport clones/checkouts. Defaults to ~/.agentic-kanban/worker. */
  workRoot?: string;
  heartbeatIntervalMs?: number;
  log?: (line: string) => void;
  /** How long `stop()` waits for in-flight result pushes (#754). */
  drainTimeoutMs?: number;
  /**
   * Called once when this daemon can never work against this board again — a 401 with no
   * pairing token to recover with, or a protocol the board refuses (#754). The daemon has
   * already stopped reconnecting by then; the CLI turns this into a non-zero exit, because
   * a red tray and a silent 30 s retry loop is the failure being removed.
   */
  onFatal?: (reason: string) => void;
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

/**
 * This machine's live headroom (#910), folded onto every heartbeat. Tier 0 only — a
 * single sync `os.freemem()` read, cheap enough for the 30s heartbeat and the `hello`
 * handshake alike, unlike Tier 1's process spawn. Never throws: `readTier0Capacity`
 * and `resolveSpareCores` both fail open, so a capacity read never blocks a heartbeat.
 */
function capacityOf(): WorkerCapacityInfo {
  const snapshot = toWorkerCapacitySnapshot(readTier0Capacity());
  return snapshot;
}

/** What this machine declares about itself, on every registration AND every beat (#754). */
function capabilitiesOf(opts: WorkerDaemonOptions): WorkerCapabilities {
  return {
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
    ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
    capacity: capacityOf(),
  };
}

/**
 * Narrow a worker's declared `--providers` down to the ones this machine can actually PROVE
 * it is authenticated for (#895). Before this, `providers` was advertised exactly like
 * `--labels` — pure operator declaration, never checked — so a login that lapsed (as in the
 * live #895 repro) kept being advertised as eligible with a 100% dispatch-failure rate and no
 * signal anywhere. `log` receives one line per EXCLUDED provider, naming the reason
 * `checkProvider` found; a provider that attests is not logged here (see call sites for the
 * change-only summary line used on re-checks).
 */
export async function attestProviders(requested: string[], log: (line: string) => void): Promise<string[]> {
  const attested: string[] = [];
  for (const provider of requested) {
    const result = await attestProviderAuth(provider);
    if (result.attested) {
      attested.push(provider);
      continue;
    }
    const reason = result.checks.find((c) => c.status !== "pass")?.detail ?? "could not be confirmed";
    log(
      `[worker] NOT advertising provider '${provider}': ${reason}. This worker will not be dispatched ` +
        `'${provider}' sessions until it re-attests as logged in (run 'agentic-kanban-worker doctor' for detail).`,
    );
  }
  return attested;
}

/** This build's own version — the same value `--version` reports. Never fabricated. */
function resolveWorkerVersion(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let up = 0; up < 5; up++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "agentic-kanban" && pkg.version) return pkg.version;
      } catch {
        /* no manifest at this level */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** A registration the board refused for a reason retrying cannot fix (#754). */
export class WorkerRegistrationRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkerRegistrationRefused";
  }
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
      // #754: the handshake. A board that speaks a different protocol says so here, once,
      // instead of the mismatch surfacing later as dropped "malformed" messages.
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerVersion: resolveWorkerVersion(),
    }),
  });
  const body = await res.json().catch(() => ({})) as {
    workerId?: string;
    workerToken?: string;
    error?: string;
    boardProtocolVersion?: number;
  };
  if (!res.ok || !body.workerId || !body.workerToken) {
    const detail = body.error ?? "unexpected response";
    // 409 = the board understood us and refuses this build. Retrying is pointless, so it
    // is a distinct error type the caller can turn into a clean non-zero exit.
    if (res.status === 409) {
      throw new WorkerRegistrationRefused(
        `Board at ${boardUrl} refuses this worker build: ${detail} ` +
          `(worker speaks protocol ${WORKER_PROTOCOL_VERSION}, board speaks ${body.boardProtocolVersion ?? "?"})`,
        res.status,
      );
    }
    throw new Error(`Registration failed (${res.status}): ${detail}`);
  }
  return { workerId: body.workerId, workerToken: body.workerToken, name };
}

/** Forget this board's pairing so a fresh `--token` can be used (#754). */
function forgetIdentity(stateFile: string, boardUrl: string): void {
  try {
    const state = loadState(stateFile);
    if (!(boardUrl in state.boards)) return;
    delete state.boards[boardUrl];
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {
    /* best-effort: the re-register below is what actually matters */
  }
}

export interface WorkerDaemonHandle {
  workerId: string;
  /** Resolves once the first WS connection is established. */
  connected: Promise<void>;
  /**
   * Stop accepting work and shut down cleanly (#754).
   *
   * Awaitable and bounded: it announces `draining` to the board, stops reconnecting,
   * optionally kills the agents, then waits up to `drainTimeoutMs` for the result pushes
   * their exits kick off and flushes the critical queue before closing the socket. The
   * report says what it saved and what it could not — see DrainReport.
   */
  stop(opts?: { killAgents?: boolean; drainTimeoutMs?: number }): Promise<DrainReport>;
  /**
   * Leave rotation WITHOUT stopping: the board stops assigning, running agents finish.
   * The planned-restart move — `draining` had no writer at all before this.
   */
  drain(): Promise<void>;
}

/**
 * What a shutdown managed to save, and what it did not (#754). Returned rather than
 * logged-and-forgotten because "nothing was lost" and "one push was abandoned" are the
 * two outcomes an operator needs told apart.
 */
export interface DrainReport {
  /** Result pushes that completed during the drain. */
  pushesCompleted: number;
  /** Sessions still pushing when the drain timed out — their work stayed on the worker. */
  pushesAbandoned: number;
  /** Agents still running at exit (only possible with killAgents: false). */
  agentsLeftRunning: number;
  /**
   * Critical messages (exit/assign_failed) that could not be delivered. The queue is
   * in-memory and capped at PENDING_QUEUE_CAP, so anything still here at exit is LOST:
   * a drain can flush the queue to a live socket, but it cannot persist it.
   */
  criticalMessagesLost: number;
  /**
   * Finished results still held on this machine because every push attempt failed (#750).
   * Their checkouts are KEPT — the daemon logs each path — so they are recoverable by
   * hand, but the in-memory retry list itself does not survive this process.
   */
  resultsRetained: number;
}

export async function startWorkerDaemon(opts: WorkerDaemonOptions): Promise<WorkerDaemonHandle> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const boardUrl = normalizeBoardUrl(opts.boardUrl);
  const stateFile = opts.stateFile ?? defaultWorkerStateFile();
  const name = opts.name ?? hostname();

  // #895: `providers` as DECLARED (--providers) is kept separate from `providers` as
  // ADVERTISED (opts.providers, mutated below) so a re-check can always re-attest the full
  // requested set — a provider excluded now may attest again later (login restored) without
  // needing a restart.
  const declaredProviders = opts.providers;
  let advertisedProviders = declaredProviders;
  if (opts.attestProviders !== false && declaredProviders && declaredProviders.length > 0) {
    advertisedProviders = await attestProviders(declaredProviders, log);
    opts = { ...opts, providers: advertisedProviders };
  }

  // #850: a checkout whose worktree registration is gone (a prior daemon that stopped,
  // disconnected, or crashed mid-session) is reaped before anything else runs, so a
  // long-lived worker never accumulates whole repo clones from abandoned sessions.
  // Best-effort — a scan failure must never block pairing/connecting.
  try {
    const reaped = await reapOrphanedCheckouts(opts.workRoot ?? defaultWorkerWorkRoot(), log);
    if (reaped.reaped.length > 0) {
      log(`[worker] startup cleanup: reaped ${reaped.reaped.length} orphaned checkout(s) of ${reaped.scanned} scanned`);
    }
  } catch (err) {
    log(`[worker] startup checkout cleanup failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

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
  let draining = false;
  let fatal: string | null = null;
  /** Re-pairings attempted, and whether one is in flight (#754 — see handleUnauthorized). */
  let repairAttempts = 0;
  let repairing = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  /**
   * The one pending reconnect timer (#858). Held so a new trigger can tell that a retry is
   * already scheduled: before this, every close scheduled its own timer and the re-pairing
   * path called `connect()` directly, so a reconnect could fire while a connect attempt was
   * still in flight — observed as 13 connects / 6 disconnects / 3 board-side evictions in
   * one log, each eviction closing the OLDER socket and feeding the loop.
   */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingCritical: WorkerToBoardMessage[] = [];
  const workerVersion = resolveWorkerVersion();

  /**
   * Give up on this board for good (#754): stop reconnecting and tell the caller why.
   * The condition this replaces is a daemon that retried a 401 every 30 s forever while
   * `worker-state.json` blocked the documented recovery ("revoke and start with a fresh
   * token") — so the advice could not be followed without hand-deleting the file the same
   * line forbids editing.
   */
  const giveUp = (reason: string): void => {
    if (fatal) return;
    fatal = reason;
    stopped = true;
    clearInterval(heartbeatTimer);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
    log(`[worker] FATAL: ${reason}`);
    opts.onFatal?.(reason);
  };

  /**
   * A 401 from the board (#754). Two very different situations wear the same status:
   * the worker was revoked/forgotten (recoverable, IF the operator supplied a fresh
   * pairing token), or the token is simply wrong (not recoverable here). Both used to
   * look exactly like network loss, which is why the tray stayed red and no log said why.
   */
  const handleUnauthorized = async (where: string): Promise<void> => {
    if (stopped || fatal || repairing) return;
    if (!opts.pairingToken) {
      giveUp(
        `board rejected this worker's token (401 on ${where}). It was probably revoked, or the ` +
          `board's database was reset. Mint a new pairing token on the board ` +
          `('agentic-kanban worker pair') and restart with --token <token>; the stale pairing in ` +
          `${stateFile} is dropped automatically when you do.`,
      );
      return;
    }
    if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
      giveUp(
        `board rejected this worker's token again after ${repairAttempts} re-pairing attempt(s) ` +
          `(401 on ${where}). A pairing token is single-use, so this is not something another ` +
          `token will fix: check that the board still lists this worker ` +
          `('agentic-kanban worker list' on the board machine) and that --board points at the ` +
          `fleet port of the board you paired with.`,
      );
      return;
    }
    // One repair at a time, and never re-entrantly: a 401 arrives on BOTH the heartbeat and
    // the socket upgrade, so an unguarded handler runs the whole recovery twice per round —
    // which is how the unbounded version reached 940 registrations in two minutes.
    repairing = true;
    repairAttempts += 1;
    log(`[worker] board rejected our identity (401 on ${where}); re-pairing with the supplied --token`);
    forgetIdentity(stateFile, boardUrl);
    try {
      identity = await registerWithBoard(opts, boardUrl, name);
      saveIdentity(stateFile, boardUrl, identity);
      log(`[worker] re-registered with ${boardUrl} as '${identity.name}' (id=${identity.workerId})`);
      repairing = false;
      if (!stopped && !fatal) connect();
    } catch (err) {
      repairing = false;
      if (err instanceof WorkerRegistrationRefused) {
        giveUp(err.message);
        return;
      }
      giveUp(`re-registration after a 401 failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

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
    // #858: one connection attempt at a time. A `connect()` while a socket is still
    // CONNECTING (or already OPEN) would open a SECOND socket for the same workerId; the
    // board sanely evicts the older one, the eviction looks like a network drop to this
    // daemon, and the two ends sustain a connect/evict flap indefinitely.
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      log(
        `[worker] connect suppressed: a connection attempt is already ` +
          `${ws.readyState === WebSocket.OPEN ? "open" : "in flight"}`,
      );
      return;
    }
    const wsUrl = `${boardUrl.replace(/^http/, "ws")}/ws/workers/${identity.workerId}`;
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${identity.workerToken}` },
    });
    ws = socket;
    let openedAt: number | null = null;

    socket.on("open", () => {
      // Wrapped whole (#870): this runs on a ws event, where a throw is a process-level
      // uncaught exception — one bad frame during the flush must not kill every agent.
      try {
        reconnectDelay = RECONNECT_MIN_MS;
        // #858: a successful connect retires any reconnect timer still pending.
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        openedAt = Date.now();
        log(`[worker] connected to ${boardUrl}`);
        socket.send(JSON.stringify({
          type: "hello",
          workerId: identity.workerId,
          runningSessionIds: runner.runningSessionIds(),
          // #754: declared on every connect, not frozen at first pairing — a machine that
          // gained docker (or changed its ceiling) says so without being re-paired.
          protocolVersion: WORKER_PROTOCOL_VERSION,
          ...(workerVersion ? { workerVersion } : {}),
          capabilities: capabilitiesOf(opts),
        } satisfies WorkerToBoardMessage));
        while (pendingCritical.length > 0) {
          socket.send(JSON.stringify(pendingCritical.shift()));
        }
        // #750: a result whose push failed while the board was unreachable can only be
        // saved by an attempt made after it is back — this is that attempt. The push lands
        // in the incoming namespace, where the #752 operator surface can land it.
        void runner.retryPendingPushes().then((outcome) => {
          if (outcome.pushed.length > 0) {
            log(`[worker] pushed ${outcome.pushed.length} retained result(s) after reconnecting`);
          }
          for (const retained of runner.unpushedResults()) {
            log(
              `[worker] still holding an unpushed result: sessionId=${retained.sessionId} ` +
                `checkout=${retained.checkoutPath} branch=${retained.localBranch} ` +
                `attempts=${retained.attempts} lastError=${retained.lastError}`,
            );
            // #871: a result whose reconnect retry ALSO failed is reported to the board,
            // which is the one place an operator actually looks. Through sendToBoard so a
            // socket that died again queues it as critical rather than dropping it.
            sendToBoard({
              type: "undelivered_result",
              sessionId: retained.sessionId,
              branch: retained.branch,
              incomingRef: retained.incomingRef,
              checkoutPath: retained.checkoutPath,
              attempts: retained.attempts,
              lastError: retained.lastError,
            });
          }
        }).catch((err: unknown) => {
          log(`[worker] retained-result retry failed unexpectedly (daemon staying up): ${err instanceof Error ? err.message : String(err)}`);
        });
        resolveConnected();
      } catch (err) {
        log(`[worker] open-handler error (daemon staying up): ${err instanceof Error ? err.message : String(err)}`);
      }
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
      try {
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
          case "sync_repo":
            runner.repoOp("sync", message.sessionId, message.requestId, message.auth);
            break;
          case "push_head":
            runner.repoOp("push", message.sessionId, message.requestId, message.auth);
            break;
          case "probe_session":
            runner.probeSession(message.sessionId, message.requestId);
            break;
        }
      } catch (err) {
        // #870: a throw out of a ws event handler is a process-level uncaught exception —
        // one bad message must not take down every agent on this machine.
        log(
          `[worker] error handling a ${message.type} message (daemon staying up): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    const scheduleReconnect = (cause: string) => {
      // `repairing` too: the re-pairing path calls connect() itself once it has a new
      // identity, and a backoff timer racing it opens a second socket with the OLD token.
      if (stopped || fatal || repairing) return;
      // #858: a STALE socket's close must not restart the loop. When `ws` points at a
      // newer socket than the one this closure was created for, that newer attempt is
      // already connecting or connected — scheduling here would be the overlap.
      if (ws !== null && ws !== socket) {
        log(`[worker] disconnected (${cause}); not retrying — a newer connection attempt already exists`);
        return;
      }
      // #858: one timer, ever. Two close-shaped events for the same lost link (an `error`
      // path racing a `close`, or an eviction landing beside a heartbeat 401) used to arm
      // two timers, each opening its own socket.
      if (reconnectTimer) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      // Say how long the connection lasted, not just when the next attempt is:
      // the retry delay resets to RECONNECT_MIN_MS on every successful open, so
      // a log of bare "retrying in 1s" lines reads like a socket that keeps
      // dying instantly, whatever its real lifetime was.
      const lifetime = openedAt === null ? "never opened" : `up ${Math.round((Date.now() - openedAt) / 1000)}s`;
      log(`[worker] disconnected (${cause}; ${lifetime}); retrying in ${Math.round(delay / 1000)}s`);
      const timer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      if (timer.unref) timer.unref();
      reconnectTimer = timer;
    };

    socket.on("close", (code: number, reason: Buffer) => {
      if (ws === socket) ws = null;
      // The close code is the only thing separating a board that dropped us on
      // purpose from a transport that died, and the two want opposite responses:
      // 1006 means the socket broke with no close frame (network path gone, board
      // process killed), while a clean 1000/1005 is the peer closing us - which is
      // what a board-side eviction of a second connection for this workerId looks
      // like. Without the code both render identically and a self-sustaining
      // reconnect/evict loop is indistinguishable from a flaky link.
      const detail = reason.length > 0 ? `: ${reason.toString("utf8").trim()}` : "";
      const kind = code === 1006 ? "transport failed, no close frame" : "closed by board";
      scheduleReconnect(`code ${code}${detail} - ${kind}`);
    });
    socket.on("error", (err) => {
      log(`[worker] socket error: ${err.message}`);
      // 'close' follows and schedules the reconnect.
    });
    // A rejected UPGRADE is an HTTP response, not a socket failure — and it is the only
    // place the board's 401/409 is visible on the WS path (#754). Without this the status
    // is swallowed and the daemon reconnects forever against a board that will never
    // accept it.
    socket.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume(); // drain, or the socket is left half-open
      if (status === 401) {
        void handleUnauthorized("the WebSocket upgrade");
        return;
      }
      if (status === 409) {
        // The steps are the shared WORKER_UPDATE_REMEDIATION (#880), so this refusal and
        // `worker update-check` cannot drift on what the fix is.
        giveUp(
          `board refuses this worker build on the WebSocket upgrade (409). This worker speaks ` +
            `protocol ${WORKER_PROTOCOL_VERSION}; ${WORKER_UPDATE_REMEDIATION}.`,
        );
      }
      // Anything else falls through to close/reconnect, which is the right response to a
      // 502 from a proxy or a board that is still starting up.
    });
  }

  connect();

  /**
   * One heartbeat. Carries the capabilities and the protocol version every time (#754),
   * and — unlike before — READS the status, because a 401 here is one of the two ways a
   * revoked worker finds out, and it was being swallowed entirely.
   */
  async function sendHeartbeat(): Promise<void> {
    if (stopped || fatal) return;
    // #895: re-attest on every beat, not just at startup — the ticket's own example is a
    // login that lapsed silently on a previously-healthy worker. Silent on an unchanged
    // result; a changed result gets exactly one summary line rather than re-explaining every
    // excluded provider's reason each beat (attestProviders already did that once, at
    // startup, and `worker doctor` gives the detail on demand).
    if (opts.attestProviders !== false && declaredProviders && declaredProviders.length > 0) {
      const reattested = await attestProviders(declaredProviders, () => {});
      if (reattested.join(",") !== (advertisedProviders ?? []).join(",")) {
        log(
          `[worker] provider attestation changed: now advertising [${reattested.join(", ") || "none"}] ` +
            `(was [${(advertisedProviders ?? []).join(", ") || "none"}])`,
        );
        advertisedProviders = reattested;
        opts.providers = advertisedProviders;
      }
    }
    let res: Response;
    try {
      res = await fetch(`${boardUrl}/api/workers/${identity.workerId}/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${identity.workerToken}`,
        },
        body: JSON.stringify({
          ...(draining ? { status: "draining" } : {}),
          capabilities: capabilitiesOf(opts),
          protocolVersion: WORKER_PROTOCOL_VERSION,
          ...(workerVersion ? { workerVersion } : {}),
        }),
      });
    } catch {
      return; // board unreachable — the WS reconnect path owns visibility for that
    }
    if (res.status === 401) {
      void handleUnauthorized("the heartbeat");
      return;
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { error?: string; boardProtocolVersion?: number };
      giveUp(
        `board refuses this worker build: ${body.error ?? "protocol mismatch"} ` +
          `(worker protocol ${WORKER_PROTOCOL_VERSION}, board ${body.boardProtocolVersion ?? "?"}). ` +
          // Shared with `worker update-check` (#880) so the two never drift on the fix.
          `To fix: ${WORKER_UPDATE_REMEDIATION}.`,
      );
    }
  }

  const heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  /** Flush queued exit/assign_failed frames. Returns how many could NOT be delivered. */
  function flushCritical(): number {
    while (pendingCritical.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(pendingCritical.shift()));
      } catch {
        break; // socket died mid-flush; the remainder is counted as lost
      }
    }
    return pendingCritical.length;
  }

  return {
    workerId: identity.workerId,
    connected,

    async drain() {
      if (draining) return;
      draining = true;
      log("[worker] draining: the board will stop assigning; running agents finish");
      // Announce immediately rather than at the next 30 s tick — the whole value of
      // draining is that the board learns before it places the next session.
      await sendHeartbeat();
    },

    async stop(stopOpts): Promise<DrainReport> {
      const timeoutMs = stopOpts?.drainTimeoutMs ?? opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      // Announce BEFORE killing anything: a board that keeps assigning into a dying
      // daemon produces exactly the launch failures this shutdown is trying to avoid.
      if (!draining && !fatal) {
        draining = true;
        await sendHeartbeat().catch(() => {});
      }
      stopped = true;
      clearInterval(heartbeatTimer);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (stopOpts?.killAgents) runner.stopAll();
      // The kill above only sends the signal. The result push is kicked off by the
      // agent's `exit` handler, so exiting now is precisely the bug: wait for it.
      const drained = await runner.drainPushes(timeoutMs);
      const criticalMessagesLost = flushCritical();
      const retained = runner.unpushedResults();
      const report: DrainReport = {
        pushesCompleted: drained.completed,
        pushesAbandoned: drained.abandoned,
        agentsLeftRunning: runner.runningSessionIds().length,
        criticalMessagesLost,
        resultsRetained: retained.length,
      };
      for (const result of retained) {
        // #750/#775: the checkout was NOT removed, so this is recoverable by hand — but
        // only if the operator is told where it is before the process goes away.
        log(
          `[worker] KEPT an unpushed result: sessionId=${result.sessionId} is in ` +
            `${result.checkoutPath} on branch ${result.localBranch} (target ${result.incomingRef}); ` +
            `last push error: ${result.lastError}`,
        );
      }
      if (report.pushesAbandoned > 0 || report.criticalMessagesLost > 0) {
        log(
          `[worker] shutdown INCOMPLETE: ${report.pushesAbandoned} result push(es) abandoned after ` +
            `${Math.round(timeoutMs / 1000)}s and ${report.criticalMessagesLost} undelivered ` +
            `exit/assign_failed message(s) lost (the queue is in memory only). The board will fall ` +
            `back to its disconnect grace for those sessions.`,
        );
      } else {
        log(`[worker] drained cleanly: ${report.pushesCompleted} result push(es) completed`);
      }
      try { ws?.close(); } catch { /* already closed */ }
      ws = null;
      return report;
    },
  };
}
