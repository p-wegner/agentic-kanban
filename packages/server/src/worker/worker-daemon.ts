// Fleet worker daemon (epic #1, phase 1b #4).
//
// Pull model: the worker dials the board â€” REST to register (pairing token â†’
// per-worker token, persisted locally) and heartbeat, a WebSocket for
// assignments and output streaming. Socket loss never kills running agents:
// the daemon keeps them, reconnects with backoff, re-announces them via
// `hello`, and queues exit/assign_failed messages while offline so session
// finalization is never lost (stdout/stderr during a gap is dropped in this
// phase). Credentials stay worker-local: the daemon runs agents with this
// machine's own logins and never receives board credentials.
//
// #754 â€” THIS IS A LONG-RUNNING PROCESS ON SOMEONE ELSE'S MACHINE, so every
// shutdown and every unrecoverable error is a data-loss bug until it is handled:
//
//  * `stop()` is ASYNC and DRAINS. It used to be sync and the CLI called
//    `process.exit(0)` immediately after, so with `--kill-agents` the process was
//    gone before `proc.on("exit")` â†’ `emitExit` â†’ `pushWorkerResult` could run:
//    completed work was never pushed and the board learned about it via the 60 s
//    grace, i.e. as a failure. Now: announce `draining` so the board stops
//    assigning, stop accepting, then wait (bounded) for in-flight pushes and
//    flush the critical queue before the socket closes.
//  * `draining` is now actually SET. It was a declared status honoured by
//    `eligibleWorkers` and coloured by the panel that nothing ever wrote, so the
//    only way out of rotation was revoke â€” which kills in-flight tokens.
//  * A 401 is FATAL, not a retry. A revoked/forgotten worker used to reconnect
//    every 30 s forever with a red tray and nothing in any log explaining it,
//    while the identity in worker-state.json blocked re-pairing even with a fresh
//    `--token`. Now a 401 either re-registers (when a `--token` is present) or
//    exits non-zero with the reason.
//  * Capabilities ride every heartbeat, not just first registration.
//  * `hello` and `register` carry a protocol version; an incompatible board
//    refuses with a sentence instead of failing as a silence.

import { readFileSync } from "node:fs";
import { homedir, platform, arch, totalmem, cpus } from "node:os";
import {
  findIdentity,
  findPreferredUrl,
  forgetIdentity,
  learnBoards,
  nextUrlIndex,
  loadState,
  normalizeBoardUrl,
  parseBoardList,
  saveIdentity,
  urlsOfBoard,
  type BoardProbe,
  type WorkerIdentity,
} from "./worker-state.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { dropSocketIfBoardHasNone, startSocketKeepalive } from "./worker-socket-keepalive.js";
import {
  parseBoardToWorkerMessage,
  WORKER_PROTOCOL_VERSION,
  WORKER_UPDATE_REMEDIATION,
  type WorkerCapabilities, type WorkerDoctorSummary,
  type WorkerProfileAttestation, type WorkerToBoardMessage,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { readWorkerCapacity } from "./worker-resources.js";
import { createDaemonToolchainInstall } from "./worker-toolchain-install.js";
import { createDaemonVerifyRunner, createFileVerifyResultStore } from "./worker-verify-runner.js"; import { resolveVerifySlots, type VerifySlotsStartOption } from "./worker-verify-slots.js"; // #1437, #1465
import type { ToolchainInstallPolicy, WorkerToolchainInstallInfo } from "@agentic-kanban/shared/lib/worker-toolchain-install";
import { createWorkerOneShotRunner } from "./worker-oneshot.js"; import { createWorkerServicesRunner } from "./worker-services.js"; // #1431, #1447
import { createWorkerAgentRunner, dispatchBoardMessage, rawDataToBuffer, type UnpushedResult } from "./worker-agent-runner.js";
import { defaultWorkerWorkRoot, reapOrphanedCheckouts } from "./worker-repo.js";
import { packageManagersField, refreshPackageManagers, refreshToolchains, toolchainsField } from "../cli/commands/worker-doctor-git-prereqs.js";
import { cleanUpBeforeStart, createPendingDeleteSweeper } from "./agent-process-tree.js";
import { attestAndNotice, attestProviders } from "./worker-provider-notice.js";
import { flushCritical, reattestProviders } from "./worker-daemon-helpers.js";
export { attestProviders };
import { defaultWorkerName, sameNamedNotice } from "./worker-name.js";
import { createDoctorSummaryTracker } from "../cli/commands/worker-doctor-daemon.js";
import { resolveProfileAliases } from "./worker-profile-aliases.js";
import { createWorkerSettingsApplier } from "./worker-settings-apply.js";
import { createWorkerProfileAttestor, type WorkerProfileAttestor } from "./worker-profiles.js";
import type { WorkerHarness } from "./worker-harness.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { createDaemonSelfUpdate, type DaemonSelfUpdate, type WorkerSelfUpdateOptions } from "./worker-daemon-update.js";
import { startWorkerControlServer } from "./worker-control.js";
import { isWorkerLogInherited, setWorkerLogSink, stampConsoleWithTimestamps, teeLogToFile, workerLogFileFor } from "./worker-updater.js";

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const RECONNECT_MIN_MS = 1000;
const CONNECT_TIMEOUT_MS = 6000;
const RECONNECT_MAX_MS = 30 * 1000;
/** #1344: while the board was reachable this recently, retries stay quick so an outage that ends is noticed in seconds. */
const RECONNECT_RECENT_WINDOW_MS = 5 * 60 * 1000;
const RECONNECT_RECENT_MAX_MS = 5 * 1000;

/** The backoff ceiling: low inside the recently-reachable window, the long cap after it. */
export function reconnectCapMs(sinceReachableMs: number | null): number {
  return sinceReachableMs !== null && sinceReachableMs < RECONNECT_RECENT_WINDOW_MS
    ? RECONNECT_RECENT_MAX_MS
    : RECONNECT_MAX_MS;
}

/** The delay to use now and the next stored backoff value (#1344). */
export function nextReconnectDelay(current: number, sinceReachableMs: number | null): { delay: number; next: number } {
  const cap = reconnectCapMs(sinceReachableMs);
  const delay = Math.min(current, cap);
  return { delay, next: Math.min(delay * 2, cap) };
}
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
 * faster version of the forever-loop it replaced â€” a board that hands out a token and then
 * rejects it produced 940 registrations in two minutes. A pairing token is single-use, so
 * the honest number is small: the FIRST re-pairing is the recovery, and anything past it
 * means the board is refusing this machine for a reason a new token cannot fix.
 */
export const MAX_REPAIR_ATTEMPTS = 2;

export interface WorkerDaemonOptions extends VerifySlotsStartOption { // #1496: verifySlots
  boardUrl: string;
  /** #1337: ordered URLs of the SAME board, preferred first (`boardUrl` is the first): failover + return, one pairing. */
  boardUrls?: string[];
  /** Required for first registration against this board; ignored once paired. */
  pairingToken?: string;
  name?: string;
  labels?: string[];
  providers?: string[];
  /**
   * Verify each declared provider can actually authenticate on THIS machine (#895) before
   * advertising it to the board, narrowing `providers` down to what `checkProvider` can
   * prove. Default true. Set false only when a provider is known-authenticated purely via
   * an env API key the doctor check cannot see (its "unknown" case) â€” this is the
   * operator asserting that a false negative, not a real gap.
   */
  attestProviders?: boolean;
  /**
   * `--profiles anth,team5x` (#1027): the agent profiles this machine ATTESTS it can
   * authenticate as. Names only â€” never a token, never a config dir.
   *
   * Absent = attest whatever local profile discovery finds, which is what makes a
   * freshly-upgraded worker useful to a profile-restricted project without extra
   * configuration. `["none"]` opts out: the worker then attests nothing and behaves
   * exactly like a protocol-1 build, i.e. restricted projects keep #651's refusal for it.
   * A declared name this machine does not hold is dropped with a log line, the same way
   * `--providers` is narrowed by attestation (#895).
   */
  profiles?: string[];
  /** `--profile-alias default=anth` (#1379): `<source>=<name>`; given = replaces + persists (`[]` clears), absent = saved list. */
  profileAliases?: string[];
  /** Override the home dir profile discovery reads. Test seam; a service install may set it. */
  profileHome?: string;
  /** The worker-owned provider config (#1367). Absent = inherit mode (today's behaviour). */
  harness?: WorkerHarness;
  /** #1370: run the local doctor and send the board a compact summary (on hello, then on change). Opt-in. */
  doctorSummary?: boolean;
  maxConcurrency?: number;
  /** #1371 `--toolchain-install` (default never) and `--toolchain-allow`: may the board have this worker install toolchains via mise? */
  toolchainInstall?: ToolchainInstallPolicy; toolchainAllow?: string[];
  /** Defaults to ~/.agentic-kanban/worker-state.json. */
  stateFile?: string;
  /** Root for git-transport clones/checkouts. Defaults to ~/.agentic-kanban/worker. */
  workRoot?: string;
  heartbeatIntervalMs?: number; pingIntervalMs?: number; pongTimeoutMs?: number; // #1376: WS ping cadence / pong deadline
  log?: (line: string) => void;
  /** How long `stop()` waits for in-flight result pushes (#754). */
  drainTimeoutMs?: number;
  lifecycle?: (ctx: import("./worker-lifecycle.js").LifecycleCtx) => import("./worker-lifecycle.js").LifecycleHandlers; // #1443: status details + stop/restart for the control endpoint
  /**
   * Called once when this daemon can never work against this board again â€” a 401 with no
   * pairing token to recover with, or a protocol the board refuses (#754). The daemon has
   * already stopped reconnecting by then; the CLI turns this into a non-zero exit, because
   * a red tray and a silent 30 s retry loop is the failure being removed.
   */
  onFatal?: (reason: string) => void;
  /**
   * Self-update (#1338). Absent = this daemon never updates itself (tests, and any caller that
   * cannot restart). Present: the board may ask this worker to update (`worker update`), and
   * with `auto` it updates on its own whenever the board advertises a different build.
   */
  selfUpdate?: WorkerSelfUpdateOptions;
}

export type { WorkerSelfUpdateOptions } from "./worker-daemon-update.js";
export function defaultWorkerStateFile(): string {
  return join(homedir(), ".agentic-kanban", "worker-state.json");
}

// #1337: the pairing state is keyed by board identity (see worker-state.ts); these stay importable from here.
export { normalizeBoardUrl, loadState, saveIdentity };

/**
 * What this machine declares about itself, on every registration AND every beat (#754).
 *
 * `profiles` (#1027) rides the same channel: a login can be added, removed or run out of quota,
 * and a value frozen at pairing time would stay a claim the board acts on after it stopped being true.
 */
function capabilitiesOf(
  opts: WorkerDaemonOptions,
  profiles?: WorkerProfileAttestation[],
  providerNotice?: string,
  doctor?: WorkerDoctorSummary,
  toolchainInstall?: WorkerToolchainInstallInfo, verify?: WorkerCapabilities["verify"], workRoot?: string,
): WorkerCapabilities {
  return {
    ...(toolchainInstall ? { toolchainInstall } : {}), ...(verify ? { verify } : {}),
    ...(providerNotice ? { providerNotice } : {}),
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
    ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
    // #910: this machine's live headroom (Tier 0 only: one sync os.freemem() read, cheap for every beat; never throws)
    capacity: readWorkerCapacity(workRoot), ...(opts.harness ? { harnessMode: opts.harness.mode } : {}), // #1451
    ...(profiles && profiles.length > 0 ? { profiles } : {}),
    // #1369/#1382: package managers + toolchains this machine has, so placement can name what a project needs.
    ...packageManagersField(), ...toolchainsField(),
    ...(doctor ? { doctor } : {}),
  };
}

/** This build's own version â€” the same value `--version` reports. Never fabricated. */
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

export async function registerWithBoard(
  opts: WorkerDaemonOptions,
  boardUrl: string,
  name: string,
  attestedProfiles?: WorkerProfileAttestation[],
  doctor?: WorkerDoctorSummary,
): Promise<WorkerIdentity> {
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
      // #1027: attested profile NAMES, so a restricted project can consider this machine
      // from its very first heartbeat rather than only after the next one lands.
      ...(attestedProfiles && attestedProfiles.length > 0 ? { profiles: attestedProfiles } : {}),
      ...(doctor ? { doctor } : {}),
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
    boardProtocolVersion?: number; sameNamed?: { id: string }[];
    boardId?: string; // #1337
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
  if (body.sameNamed?.length) (opts.log ?? console.log)(sameNamedNotice(name, body.sameNamed)); // #1390
  return { workerId: body.workerId, workerToken: body.workerToken, name, ...(body.boardId ? { boardId: body.boardId } : {}) };
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
   * report says what it saved and what it could not â€” see DrainReport.
   */
  stop(opts?: { killAgents?: boolean; drainTimeoutMs?: number }): Promise<DrainReport>;
  /**
   * Leave rotation WITHOUT stopping: the board stops assigning, running agents finish.
   * The planned-restart move â€” `draining` had no writer at all before this.
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
  /** Sessions still pushing when the drain timed out â€” their work stayed on the worker. */
  pushesAbandoned: number;
  /** #1461: which sessions/branches those were; each is persisted to the undelivered-results store. */
  abandonedSessions?: { sessionId: string; branch: string }[];
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
   * Their checkouts are KEPT â€” the daemon logs each path â€” so they are recoverable by
   * hand, but the in-memory retry list itself does not survive this process.
   */
  resultsRetained: number;
}

/**
 * #750: a result whose push failed while the board was unreachable can only be saved by an
 * attempt made after it is back â€” this is that attempt, run on every (re)connect. The push
 * lands in the incoming namespace, where the #752 operator surface can land it.
 */
function retryRetainedResults(
  runner: ReturnType<typeof createWorkerAgentRunner>,
  sendToBoard: (message: WorkerToBoardMessage) => void,
  log: (line: string) => void,
): void {
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
      // #871: a result whose reconnect retry ALSO failed is reported to the board, which is the
      // one place an operator actually looks. Through sendToBoard so a socket that died again
      // queues it as critical rather than dropping it.
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
}

function logShutdownReport(
  report: DrainReport,
  retained: UnpushedResult[],
  timeoutMs: number,
  log: (line: string) => void,
): void {
  for (const result of retained) {
    // #750/#775: the checkout was NOT removed; tell the operator where it is before the process goes away.
    log(
      `[worker] KEPT an unpushed result: sessionId=${result.sessionId} is in ` +
        `${result.checkoutPath} on branch ${result.localBranch} (target ${result.incomingRef}); ` +
        `last push error: ${result.lastError}`,
    );
  }
  if (report.pushesAbandoned > 0 || report.criticalMessagesLost > 0) {
    const named = (report.abandonedSessions ?? []).map((s) => `${s.sessionId} (branch ${s.branch})`).join(", ");
    log(
      `[worker] shutdown INCOMPLETE: ${report.pushesAbandoned} push(es) still in flight after ${Math.round(timeoutMs / 1000)}s` +
        `${named ? `: ${named}` : ""} - saved to undelivered-results.json, checkout kept, delivered on next start; ` +
        `${report.criticalMessagesLost} exit/assign_failed message(s) lost (in-memory queue).`,
    );
  } else {
    log(`[worker] drained cleanly: ${report.pushesCompleted} result push(es) completed`);
  }
}

/**
 * #1337: learn which board each URL is, then resume the pairing held for that board or register on
 * the first URL that answers. Kept out of `startWorkerDaemon` (nloc ratchet).
 */
async function resolvePairing(a: {
  opts: WorkerDaemonOptions; stateFile: string; boardUrls: string[]; name: string;
  profiles: WorkerProfileAttestation[]; doctor?: WorkerDoctorSummary; log: (line: string) => void;
}): Promise<{ identity: WorkerIdentity; urlIndex: number; probes: BoardProbe[] }> {
  const { probes, firstReachable: urlIndex } = await learnBoards(a.stateFile, a.boardUrls, a.log);
  const url = a.boardUrls[urlIndex]!;
  const found = a.boardUrls.map((u) => findIdentity(loadState(a.stateFile), u)).find((i) => i !== undefined);
  if (found) {
    a.log(`[worker] resuming pairing with ${url} as '${found.name}' (id=${found.workerId})`);
    return { identity: found, urlIndex, probes };
  }
  const identity = await registerWithBoard(a.opts, url, a.name, a.profiles, a.doctor);
  saveIdentity(a.stateFile, url, identity, urlsOfBoard(a.boardUrls, probes, identity.boardId));
  a.log(`[worker] registered with ${url} as '${identity.name}' (id=${identity.workerId}); to use another name, pair again with --name <name>`);
  return { identity, urlIndex, probes };
}

/** #895: re-attest the declared providers (unless disabled); returns opts advertising only what attested. */
async function attestDeclaredProviders(opts: WorkerDaemonOptions, log: (line: string) => void): Promise<{ opts: WorkerDaemonOptions; notice?: string }> {
  const declared = opts.providers;
  if (opts.attestProviders === false || !declared || declared.length === 0) return { opts };
  const { advertised, notice } = await attestAndNotice(declared, log, opts.harness);
  if (notice) log(`[worker] WARNING: ${notice}`);
  return { opts: { ...opts, providers: advertised }, ...(notice ? { notice } : {}) };
}

/** #1027: what this machine can authenticate as, built once and re-read per beat. */
function buildProfileAttestor(opts: WorkerDaemonOptions, aliases: ReturnType<typeof resolveProfileAliases>, log: (line: string) => void): WorkerProfileAttestor {
  return createWorkerProfileAttestor({
    aliases, log, ...(opts.profiles ? { declared: opts.profiles } : {}), ...(opts.profileHome ? { home: opts.profileHome } : {}),
  });
}

export async function startWorkerDaemon(opts: WorkerDaemonOptions): Promise<WorkerDaemonHandle> {
  const stateFile = opts.stateFile ?? defaultWorkerStateFile();
  // #1381: flags pin their keys; the rest start from what the board last pushed.
  const settings = createWorkerSettingsApplier({ opts, stateFile, boardUrl: parseBoardList([opts.boardUrl, ...(opts.boardUrls ?? [])])[0]!, log: (line) => log(line) });
  opts = settings.effectiveOptions(opts);
  // #1340: an injected `log` (tests) is left alone; the real daemon also keeps a log file.
  // #1334: an injected `log` (tests) leaves the global console alone.
  if (!opts.log) stampConsoleWithTimestamps();
  const log = opts.log ?? teeLogToFile(
    (line: string) => console.log(line),
    workerLogFileFor(stateFile),
    { inherited: isWorkerLogInherited() },
  );
  // #1351: the runner, repo ops and result push log through the same sink as the daemon.
  setWorkerLogSink(log);
  const boardUrls = parseBoardList([opts.boardUrl, ...(opts.boardUrls ?? [])]);
  const boardUrl = boardUrls[0]!; // #1372: on WSL the hostname is the Windows host's, so the default carries the distro.
  const name = opts.name ?? defaultWorkerName();

  // #895: `providers` as DECLARED (--providers) is kept separate from `providers` as
  // ADVERTISED (opts.providers, mutated below) so a re-check can always re-attest the full
  // requested set â€” a provider excluded now may attest again later (login restored) without
  // needing a restart.
  // #1027: what this machine can authenticate as. Built once here (discovery is a
  // filesystem walk) and re-read for quota on every beat; `current()` re-reads the ROLE
  // carriers each time, so a role a human just changed with claude-pick takes effect
  // without restarting the daemon â€” the same freshness rule the board's own roster has.
  const profileAliases = resolveProfileAliases(stateFile, opts.profileAliases, log, opts.harness?.dirFor("claude"));
  const profileAttestor = buildProfileAttestor(opts, profileAliases, log);
  const attestedProfiles = (): WorkerProfileAttestation[] => profileAttestor.current();
  const declaredProviders = opts.providers;
  let providerNotice: string | undefined;
  ({ opts, notice: providerNotice } = await attestDeclaredProviders(opts, log));
  let advertisedProviders = opts.providers;
  // #850: a checkout whose worktree registration is gone (a prior daemon that stopped,
  // disconnected, or crashed mid-session) is reaped before anything else runs, so a
  // long-lived worker never accumulates whole repo clones from abandoned sessions.
  // Best-effort â€” a scan failure must never block pairing/connecting.
  // #1336: a previous daemon's leftover agent trees are killed first (agent-process-tree.ts).
  const workRoot = opts.workRoot ?? defaultWorkerWorkRoot(stateFile); // #1401: own root per non-default state file
  await cleanUpBeforeStart(workRoot, log);
  const toolchains = createDaemonToolchainInstall({ policy: opts.toolchainInstall ?? "never", allow: opts.toolchainAllow ?? [], stateFile, log, sendToBoard: (m) => sendToBoard(m), heartbeat: () => sendHeartbeat() }); // #1371
  const verifySlots = resolveVerifySlots(opts.verifySlots, totalmem() / 2 ** 30, cpus().length); /* #1496 */ const verifyJobs = createDaemonVerifyRunner({ workRoot, boardUrl: () => boardUrl, sendToBoard: (m) => sendToBoard(m), log, slots: verifySlots, ramGb: Math.round(totalmem() / 2 ** 30), isConnected: () => ws?.readyState === WebSocket.OPEN, store: createFileVerifyResultStore(workRoot) }); // #1437: gates/sweeps the board places on this worker
  await Promise.all([refreshPackageManagers(), refreshToolchains(), toolchains.installer.refreshMise()]);

  // #1370: the worker's own doctor, summarised. hello/register always carry the current summary; a
  // heartbeat carries it only when it differs from what the board last got (`pending`).
  const doctor = createDoctorSummaryTracker({
    enabled: opts.doctorSummary === true, log, boardUrl, stateFile, providers: declaredProviders ?? [],
    profiles: opts.profiles, harness: opts.harness, home: opts.profileHome, workRoot,
    runningEntry: opts.selfUpdate?.entry ?? null,
  });
  await doctor.refresh();
  const paired = await resolvePairing({ opts, stateFile, boardUrls, name, profiles: attestedProfiles(), doctor: doctor.takeCurrent(), log });
  const { probes } = paired;
  let urlIndex = paired.urlIndex;
  let identity = paired.identity;
  const currentUrl = (): string => boardUrls[urlIndex]!;
  let ws: WebSocket | null = null;
  let stopped = false;
  let draining = settings.startDrained();
  let fatal: string | null = null;
  /** Re-pairings attempted, and whether one is in flight (#754 â€” see handleUnauthorized). */
  let repairAttempts = 0;
  let repairing = false;
  let switchTarget: number | null = null; // #1337: a preferred URL answered again; the next reconnect dials it
  let reconnectDelay = RECONNECT_MIN_MS;  /** Last moment a socket to the board was open (#1344); null until the first successful connect. */
  let lastReachableAt: number | null = null;
  /**
   * The one pending reconnect timer (#858). Held so a new trigger can tell that a retry is
   * already scheduled: before this, every close scheduled its own timer and the re-pairing
   * path called `connect()` directly, so a reconnect could fire while a connect attempt was
   * still in flight â€” observed as 13 connects / 6 disconnects / 3 board-side evictions in
   * one log, each eviction closing the OLDER socket and feeding the loop.
   */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingCritical: WorkerToBoardMessage[] = [];
  const workerVersion = resolveWorkerVersion();

  /**
   * Give up on this board for good (#754): stop reconnecting and tell the caller why.
   * The condition this replaces is a daemon that retried a 401 every 30 s forever while
   * `worker-state.json` blocked the documented recovery ("revoke and start with a fresh
   * token") â€” so the advice could not be followed without hand-deleting the file the same
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
    // the socket upgrade, so an unguarded handler runs the whole recovery twice per round â€”
    // which is how the unbounded version reached 940 registrations in two minutes.
    repairing = true;
    repairAttempts += 1;
    log(`[worker] board rejected our identity (401 on ${where}); re-pairing with the supplied --token`);
    forgetIdentity(stateFile, currentUrl());
    try {
      identity = await registerWithBoard(opts, currentUrl(), name);
      saveIdentity(stateFile, currentUrl(), identity, urlsOfBoard(boardUrls, probes, identity.boardId));
      log(`[worker] re-registered with ${currentUrl()} as '${identity.name}' (id=${identity.workerId})`);
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
    boardUrl: currentUrl, // #1337: read at use time, so git follows the connected URL
    workRoot, maxConcurrency: opts.maxConcurrency,
    onAuthFailure: (profile) => profileAttestor.markAuthExpired(profile),
    ...(opts.harness ? { harness: opts.harness } : {}),
    profileAliases, ...(opts.profileHome ? { profileHome: opts.profileHome } : {}),
  });
  const oneShots = createWorkerOneShotRunner({ send: (m) => sendToBoard(m), boardUrl: currentUrl, workRoot, ...(opts.harness ? { harness: opts.harness } : {}), profileAliases, ...(opts.profileHome ? { profileHome: opts.profileHome } : {}), isDraining: () => draining }); const services = createWorkerServicesRunner({ send: (m) => sendToBoard(m), cwdForSession: (id) => runner.checkoutCwd(id), isDraining: () => draining }); // #1431, #1447

  /**
   * #1338: a freshly started daemon says `online` on its FIRST heartbeat. A worker that was
   * drained for an update comes back as a new process, and nothing else flips the board's
   * stored `draining` status back â€” `status` was only ever sent when draining.
   */
  let announceOnline = true;
  const selfUpdate: DaemonSelfUpdate | null = opts.selfUpdate
    ? createDaemonSelfUpdate({
        opts: opts.selfUpdate,
        stateFile,
        get boardUrl() { return currentUrl(); },
        workerToken: () => identity.workerToken,
        workerVersion,
        log,
        runningCount: () => runner.runningSessionIds().length,
        settle: async () => { await runner.drainPushes(opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS); },
        drain: async () => {
          if (draining) return;
          draining = true;
          await sendHeartbeat();
        },
        undrain: async () => {
          if (!draining) return;
          draining = false;
          announceOnline = true;
          log("[worker] back in rotation");
          await sendHeartbeat();
        },
      })
    : null;

  // #1355: a loopback control endpoint so `update-check --apply` on this machine can ask THIS daemon
  // to update. Only a daemon that can update itself opens one.
  const controlServer = selfUpdate
    ? await startWorkerControlServer({
        stateFile,
        boardUrl,
        workerVersion,
        log,
        handlers: { updateNow: () => selfUpdate.updateNow(), status: () => selfUpdate.controlStatus(), ...opts.lifecycle?.({ stateFile, workRoot, boardUrl, draining: () => draining, sessionsLeft: () => runner.runningSessionIds().length, effective: () => ({ ...settings.effectiveOptions(opts), verifySlots }), pinned: () => settings.report().pinned, desired: () => settings.desired(), profiles: () => attestedProfiles().map((p) => `${p.provider}:${p.name}`), harnessMode: () => opts.harness?.mode, verify: () => verifyJobs.capability() }) }, // #1443/#1451/#1479
      })
    : null;

  let resolveConnected!: () => void; const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });

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
    const dialedUrl = currentUrl();
    const wsUrl = `${dialedUrl.replace(/^http/, "ws")}/ws/workers/${identity.workerId}`;
    // #1335: handshakeTimeout fails a dead connect in seconds so backoff, not the OS ETIMEDOUT (~22s), sets the pace.
    const socket = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${identity.workerToken}` }, handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    ws = socket;
    let openedAt: number | null = null;

    socket.on("open", () => {
      // Wrapped whole (#870): this runs on a ws event, where a throw is a process-level
      // uncaught exception â€” one bad frame during the flush must not kill every agent.
      try {
        reconnectDelay = RECONNECT_MIN_MS;
        // #858: a successful connect retires any reconnect timer still pending.
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        openedAt = Date.now();
        lastReachableAt = openedAt;
        log(`[worker] connected to ${dialedUrl}`);
        socket.send(JSON.stringify({
          type: "hello",
          workerId: identity.workerId,
          runningSessionIds: runner.runningSessionIds(),
          // #754: declared on every connect, not frozen at first pairing â€” a machine that
          // gained docker (or changed its ceiling) says so without being re-paired.
          protocolVersion: WORKER_PROTOCOL_VERSION,
          ...(workerVersion ? { workerVersion } : {}),
          capabilities: capabilitiesOf(opts, attestedProfiles(), providerNotice, doctor.takeCurrent(), toolchains.installer.info(), verifyJobs.capability(), workRoot),
        } satisfies WorkerToBoardMessage));
        while (pendingCritical.length > 0) {
          socket.send(JSON.stringify(pendingCritical.shift()));
        }
        retryRetainedResults(runner, sendToBoard, log); verifyJobs.onConnected(); // #1465: re-announce running verify jobs, deliver verdicts buffered while disconnected
        selfUpdate?.onConnected();
        resolveConnected();
      } catch (err) {
        log(`[worker] open-handler error (daemon staying up): ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    startSocketKeepalive(socket, opts, log); // #1376
    socket.on("message", (data) => {
      // `data` is ws's RawData: Buffer | ArrayBuffer | Buffer[]. A bare `.toString()` on the
      // array case yields comma-joined garbage rather than the frame (no-base-to-string).
      const message = parseBoardToWorkerMessage(rawDataToBuffer(data).toString("utf8"));
      if (!message) {
        log(`[worker] dropping malformed board message`);
        return;
      }
      if (toolchains.handle(message) || oneShots.handle(message) || verifyJobs.handle(message) || services.handle(message)) return; // #1431, #1437, #1447
      try {
        dispatchBoardMessage(message, runner, sendToBoard, draining);
      } catch (err) {
        // #870: a throw out of a ws event handler is a process-level uncaught exception â€”
        // one bad message must not take down every agent on this machine.
        log(
          `[worker] error handling a ${message.type} message (daemon staying up): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    const scheduleReconnect = (cause: string, boardRestarting = false) => {
      // `repairing` too: the re-pairing path calls connect() itself once it has a new
      // identity, and a backoff timer racing it opens a second socket with the OLD token.
      if (stopped || fatal || repairing) return;
      // #858: a STALE socket's close must not restart the loop. When `ws` points at a
      // newer socket than the one this closure was created for, that newer attempt is
      // already connecting or connected â€” scheduling here would be the overlap.
      if (ws !== null && ws !== socket) {
        log(`[worker] disconnected (${cause}); not retrying - a newer connection attempt already exists`);
        return;
      }
      // #858: one timer, ever. Two close-shaped events for the same lost link (an `error`
      // path racing a `close`, or an eviction landing beside a heartbeat 401) used to arm
      // two timers, each opening its own socket.
      if (reconnectTimer) return;
      if (openedAt !== null) lastReachableAt = Date.now();
      // #1354: a 1001 close is the board announcing a restart — expected, so the first retry is
      // the short minimum rather than wherever the error backoff had climbed to.
      if (boardRestarting) reconnectDelay = RECONNECT_MIN_MS;
      if (boardUrls.length > 1) {
        urlIndex = nextUrlIndex(urlIndex, boardUrls.length, openedAt !== null, switchTarget);
        switchTarget = null;
        if (openedAt === null) {
          if (urlIndex !== 0) reconnectDelay = RECONNECT_MIN_MS;
          log(`[worker] ${dialedUrl} did not answer; trying ${currentUrl()} next`);
        }
      }
      const { delay, next } = nextReconnectDelay(
        reconnectDelay, lastReachableAt === null ? null : Date.now() - lastReachableAt);
      reconnectDelay = next;
      // Say how long the connection lasted, not just when the next attempt is:
      // the retry delay resets to RECONNECT_MIN_MS on every successful open, so
      // a log of bare "retrying in 1s" lines reads like a socket that keeps
      // dying instantly, whatever its real lifetime was.
      const lifetime = openedAt === null ? "never opened" : `up ${Math.round((Date.now() - openedAt) / 1000)}s`;
      if (boardRestarting) log("[worker] board restarting, reconnecting");
      else log(`[worker] disconnected (${cause}; ${lifetime}); retrying in ${Math.round(delay / 1000)}s`);
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
      scheduleReconnect(`code ${code}${detail} - ${kind}`, code === 1001);
    });
    socket.on("error", (err) => {
      log(`[worker] socket error: ${err.message}`);
      // 'close' follows and schedules the reconnect.
    });
    // A rejected UPGRADE is an HTTP response, not a socket failure â€” and it is the only
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

  const settingsControls = {
    setMaxConcurrency: (n: number) => { opts.maxConcurrency = n; runner.setMaxConcurrency(n); },
    setLabels: (labels: string[]) => { opts.labels = labels; },
    setDrain: (on: boolean) => { if (on === draining) return; draining = on; if (!on) announceOnline = true; void sendHeartbeat(); },
  };
  selfUpdate?.begin();
  connect();

  /** #1337: on a fallback URL, once a more preferred one answers (same board) drop the socket so the reconnect dials it. */
  async function returnToPreferredUrl(): Promise<void> {
    if (urlIndex === 0 || switchTarget !== null || stopped || fatal || !ws || ws.readyState !== WebSocket.OPEN) return;
    const socket = ws;
    const i = await findPreferredUrl(boardUrls, urlIndex, identity.boardId);
    if (i === null || stopped || fatal || ws !== socket || switchTarget !== null || i >= urlIndex) return;
    log(`[worker] preferred board URL ${boardUrls[i]} answers again; switching back from ${currentUrl()}`);
    switchTarget = i;
    socket.close(1000, "switching to a preferred board url");
  }

  /**
   * One heartbeat. Carries the capabilities and the protocol version every time (#754),
   * and â€” unlike before â€” READS the status, because a 401 here is one of the two ways a
   * revoked worker finds out, and it was being swallowed entirely.
   */
  async function sendHeartbeat(): Promise<void> {
    if (stopped || fatal) return;
    void returnToPreferredUrl();
    // #895: re-attest on every beat, not just at startup â€” the ticket's own example is a
    // login that lapsed silently on a previously-healthy worker. Silent on an unchanged
    // result; a changed result gets exactly one summary line rather than re-explaining every
    // excluded provider's reason each beat (attestProviders already did that once, at
    // startup, and `worker doctor` gives the detail on demand).
    const att = await reattestProviders(opts, declaredProviders, advertisedProviders, log);
    if (att) {
      providerNotice = att.notice;
      advertisedProviders = att.advertised;
      opts.providers = advertisedProviders;
    }
    // #1027: ONE quota tick per beat â€” at most one request to the usage endpoint, over the
    // profiles that are due. Never throws: a quota read is diagnostics, and a rate limit
    // must not cost this machine its heartbeat (which is what would take it offline).
    try {
      await profileAttestor.refreshQuota();
    } catch (err) {
      log(`[worker] profile quota refresh failed (continuing): ${errorMessage(err)}`);
    }
    // #1370: re-run the doctor in the background every few minutes; it never delays a beat.
    doctor.refreshIfDue();
    const doctorToSend = doctor.pending();
    let res: Response;
    try {
      res = await fetch(`${currentUrl()}/api/workers/${identity.workerId}/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${identity.workerToken}`,
        },
        body: JSON.stringify({
          settings: settings.report(),
          // Not gated on selfUpdate: a daemon restarted after a Ctrl+C drain without --auto-update
          // (every Linux worker until #1374) otherwise stayed `draining` on the board forever.
          ...(draining ? { status: "draining" } : announceOnline ? { status: "online" } : {}),
          capabilities: capabilitiesOf(opts, attestedProfiles(), providerNotice, doctorToSend, toolchains.installer.info(), verifyJobs.capability(), workRoot),
          protocolVersion: WORKER_PROTOCOL_VERSION,
          ...(workerVersion ? { workerVersion } : {}),
          ...(selfUpdate ? { update: selfUpdate.state() } : {}),
        }),
      });
    } catch {
      return; // board unreachable â€” the WS reconnect path owns visibility for that
    }
    if (res.ok) announceOnline = false;
    if (res.ok && doctorToSend) doctor.markSent(doctorToSend);
    if (res.ok) {
      // #1338: the board advertises its build (and, for `worker update`, asks for NOW) in the
      // heartbeat response. Never let a malformed body cost this daemon its heartbeat.
      try {
        const body = dropSocketIfBoardHasNone(await res.json(), ws, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS, log);
        selfUpdate?.onHeartbeatResponse(body);
        settings.onHeartbeatResponse(body, settingsControls);
      } catch {
        /* an older board answers {ok:true} only */
      }
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

  const sweepPending = createPendingDeleteSweeper(workRoot, log); const heartbeatTimer = setInterval(() => { void sendHeartbeat(); sweepPending(); }, opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  const stopApprovalPolling = toolchains.startPolling(); // `toolchain approve <id>` is a file the CLI writes

  return {
    workerId: identity.workerId,
    connected,

    async drain() {
      if (draining) return;
      draining = true;
      log("[worker] draining: the board will stop assigning; running agents finish");
      // Announce immediately rather than at the next 30 s tick â€” the whole value of
      // draining is that the board learns before it places the next session.
      await sendHeartbeat();
    },

    async stop(stopOpts): Promise<DrainReport> {
      const timeoutMs = stopOpts?.drainTimeoutMs ?? opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      // Announce BEFORE killing anything: a board assigning into a dying daemon causes launch failures.
      if (!draining && !fatal) {
        draining = true;
        await sendHeartbeat().catch(() => {});
      }
      stopped = true;
      selfUpdate?.dispose();
      void controlServer?.close();
      clearInterval(heartbeatTimer);
      stopApprovalPolling();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (stopOpts?.killAgents) { runner.stopAll(); void services.stopAll(); }
      else runner.releaseAgents(); // #1336: --leave-agents â€” the trees survive on purpose
      // The kill only signals; the push starts in the agent's `exit` handler, so wait for it.
      const drained = await runner.drainPushes(timeoutMs);
      const criticalMessagesLost = flushCritical(ws, pendingCritical);
      const retained = runner.unpushedResults();
      setWorkerLogSink(null);
      const report: DrainReport = {
        pushesCompleted: drained.completed,
        pushesAbandoned: drained.abandoned,
        abandonedSessions: drained.abandonedSessions,
        agentsLeftRunning: runner.runningSessionIds().length,
        criticalMessagesLost,
        resultsRetained: retained.length,
      };
      logShutdownReport(report, retained, timeoutMs, log);
      try { ws?.close(); } catch { /* already closed */ }
      ws = null;
      return report;
    },
  };
}
