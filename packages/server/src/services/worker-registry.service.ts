// Worker registry — board-side control plane for the worker fleet (epic #1,
// phase 1a #3).
//
// Trust model (mirrors the MCP HTTP bridge, http-transport.ts): the /api/workers
// surface is designed to be reachable OFF loopback, so worker-called endpoints
// authenticate with bearer tokens from day one. Two token kinds:
//  - PAIRING token: minted by the board owner (loopback UI/CLI), short-lived,
//    single-use, held in memory only — presented once at registration.
//  - WORKER token: issued at registration, returned to the worker exactly once,
//    stored here only as a sha-256 hash, verified with a constant-time compare.
// Board credentials never flow to workers; workers use their machine-local
// agent logins (enforced for launch specs by lib/remote-spec-env.ts, #244).
//
// Revocation is not just a row delete: `revokeWorker` also fires the registered
// revoke listeners, which close the worker's live WebSocket and invalidate its
// scoped git tokens (#247) — otherwise a revoked machine keeps streaming into
// in-flight sessions and keeps cloning/pushing until the board restarts.

import { parseWorkerVerifyCapability, type WorkerVerifyCapability } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createExpiringDigestStore, mintToken, sha256Hex } from "../lib/bearer-token.js";
import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import * as workerRepo from "../repositories/worker.repository.js";
import type { WorkerRow } from "../repositories/worker.repository.js";
import {
  checkProtocolCompatibility,
  WORKER_PROTOCOL_VERSION,
  parseWorkerProfileAttestations,
  parseWorkerPackageManagers,
  parseWorkerDoctorSummary,
  type WorkerDoctorSummary,
  type WorkerPackageManagers,
  type WorkerCapabilities,
  type WorkerCapacityInfo,
  type WorkerProfileAttestation,
} from "@agentic-kanban/shared/lib/worker-protocol";
import { parseWorkerToolchains, type WorkerToolchains } from "@agentic-kanban/shared/lib/worker-toolchains";
import {
  parseWorkerToolchainInstallInfo,
  type ToolchainInstallRecord,
  type ToolchainInstallStatus,
  type WorkerToolchainInstallInfo,
} from "@agentic-kanban/shared/lib/worker-toolchain-install";

import { recordWorkerEvent } from "./worker-events.service.js";
import type { WorkerUpdateReport } from "../lib/worker-update.js";

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;
/** A worker whose last heartbeat is older than this reads as offline. */
export const WORKER_HEARTBEAT_STALE_MS = 90 * 1000;

import {
  parseWorkerSettingsEnvelope,
  type WorkerSettings, type WorkerSettingsEnvelope, type WorkerSettingsReport,
} from "@agentic-kanban/shared/lib/worker-settings";

export const WORKER_STATUSES = ["online", "draining", "offline"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface RegisterWorkerInput {
  pairingToken: string;
  name: string;
  os?: string;
  arch?: string;
  labels?: string[];
  providers?: string[];
  maxConcurrency?: number;
  /** #754: the wire protocol this worker speaks. Absent = a pre-handshake build. */
  protocolVersion?: number;
  /** #754: the worker package build, for the panel and `worker list`. */
  workerVersion?: string;
  /** #1027: agent profiles this machine attests it can authenticate as. Names, never secrets. */
  profiles?: WorkerProfileAttestation[];
  /** #1370: the worker's doctor summary at registration. */
  doctor?: WorkerDoctorSummary;
  /** Test seam for time-dependent behavior (pairing expiry). */
  now?: string;
}

/**
 * Prefix on every refusal caused by a protocol mismatch (#754). Routes map it to 409 and
 * the daemon treats a 409 as FATAL rather than as one more thing to retry at 30s forever
 * — the whole point being that a version mismatch is not a transient condition.
 */
export const PROTOCOL_MISMATCH_PREFIX = "incompatible worker protocol:";

/**
 * A worker as exposed to callers. `tokenHash` is deliberately OMITTED — it is a
 * credential digest, and shipping it to the UI/CLI would hand every board client
 * material to brute-force a worker token offline. It stays inside this service.
 */
export interface WorkerView extends Omit<WorkerRow, "tokenHash" | "desiredSettings"> {
  /** Stored status downgraded to "offline" when the heartbeat is stale/absent. */
  effectiveStatus: WorkerStatus;
  /**
   * The protocol and build this worker last reported (#754).
   *
   * Deliberately IN MEMORY rather than a `workers` column: it is a property of the
   * running peer, not of the pairing, and a board restart re-learns it from the next
   * heartbeat (<= 30 s) instead of showing a number that may already be a build old. The
   * ticket asks for a column too; that needs a migration and is not done here.
   */
  protocolVersion?: number;
  workerVersion?: string;
  /**
   * This worker's live headroom, as of its last heartbeat (#910). In memory for the same
   * reason `protocolVersion`/`workerVersion` are: it is a property of the running peer's
   * CURRENT state, not of the pairing, and stamping it into a `workers` column would show
   * a number that is already a heartbeat interval stale after a board restart. Absent =
   * unknown — a worker build older than #910, or one that hasn't beaten yet — and
   * placement must treat that exactly as it did before this field existed.
   */
  capacity?: WorkerCapacityInfo;
  /**
   * What this worker last ATTESTED about its agent profiles (#1027).
   *
   * In memory, for the same reason `capacity` is: it is a property of the RUNNING peer —
   * a login can be added or removed, and the quota half is only meaningful as a fresh
   * reading. A stale column would be worse than absence here, because absence is
   * correctly read as "attests nothing" and therefore as #651's refusal, while a stale
   * column would be read as a permission.
   */
  profiles?: WorkerProfileAttestation[];
  /** Package managers on this worker's PATH, as of its last hello/heartbeat (#1369). In memory like `capacity`. */
  packageManagers?: WorkerPackageManagers;
  /** Toolchains (node/java/go/...) on this worker's PATH, as of its last hello/heartbeat (#1382). In memory like `capacity`. */
  toolchains?: WorkerToolchains;
  /** The worker's own install policy for project toolchains (#1371): never|ask|auto, its allowlist, whether mise is present. */
  toolchainInstallPolicy?: WorkerToolchainInstallInfo;
  /** Verify-job capability + free slots as of the last heartbeat (#1437). In memory like `capacity`. */
  verify?: WorkerVerifyCapability;
  /** The latest install the board asked this worker for and how it is going (#1371): pending/installing/failed/done. */
  toolchainInstall?: ToolchainInstallRecord;
  /** Why this worker advertises no usable provider, as of its last hello/heartbeat (#1372). In memory like `capacity`. */
  providerNotice?: string;
  /** The worker's latest doctor summary (#1370). In memory like `capacity`; re-sent on hello and on change. */
  doctor?: WorkerDoctorSummary;
  /**
   * What this worker last said about its self-update (#1338): `current`, `updating` (with the
   * phase) or `failed` (with the reason). In memory like `capacity`: a property of the running
   * peer, re-sent on every heartbeat, so a board restart re-learns it within one beat.
   */
  update?: WorkerUpdateReport;
  /** A board-side `worker update` is waiting for this worker's next heartbeat to pick it up. */
  updateRequested?: boolean;
  /**
   * #1381: what an operator set for this worker on the board, and what the worker said about
   * its side (pinned keys, last applied rev). `labels`/`providers`/`maxConcurrency`/`status`
   * above already carry the OVERLAID values placement reads.
   */
  desiredSettings?: WorkerSettingsEnvelope;
  settingsReport?: WorkerSettingsReport;
}

/** Constant-time compare that does not leak length via an early return. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function effectiveStatus(row: WorkerRow, nowMs: number): WorkerStatus {
  const stored = (WORKER_STATUSES as readonly string[]).includes(row.status)
    ? (row.status as WorkerStatus)
    : "offline";
  if (stored === "offline") return "offline";
  if (!row.lastHeartbeatAt) return "offline";
  const age = nowMs - new Date(row.lastHeartbeatAt).getTime();
  if (!Number.isFinite(age) || age > WORKER_HEARTBEAT_STALE_MS) return "offline";
  return stored;
}

export function createWorkerRegistry(database: Database = realDb) {
  /**
    * Pending pairing tokens, keyed by digest. In-memory by design. #556: this was a bare
    * `Map<hash, expiresAtMs>` that only ever deleted the entry it consumed, so an unclaimed
    * pairing token stayed in memory until the process exited; the shared store prunes on
    * every issue.
    */
  const pendingPairings = createExpiringDigestStore<true>({ ttlMs: PAIRING_TOKEN_TTL_MS });

  /** What each worker last told us about itself (#754). See WorkerView for why not a column. */
  const reportedVersions = new Map<string, { protocolVersion?: number; workerVersion?: string }>();

  /** This worker's headroom as of its last heartbeat (#910). See WorkerView for why not a column. */
  const reportedCapacity = new Map<string, WorkerCapacityInfo>();

  /** This worker's attested profiles (#1027). See WorkerView for why not a column. */
  const reportedProfiles = new Map<string, WorkerProfileAttestation[]>();

  /** Package managers each worker has on PATH (#1369). See WorkerView for why not a column. */
  const reportedPackageManagers = new Map<string, WorkerPackageManagers>();

  /** Toolchains each worker detected on PATH (#1382). See WorkerView for why not a column. */
  const reportedToolchains = new Map<string, WorkerToolchains>();
  /** Install policy each worker declared, and the latest install request per worker (#1371). In memory like toolchains. */
  const reportedInstallInfo = new Map<string, WorkerToolchainInstallInfo>();
  const reportedVerify = new Map<string, WorkerVerifyCapability>(); // #1437
  const toolchainInstalls = new Map<string, ToolchainInstallRecord>();

  /** Why a worker advertises no usable provider (#1372); absent = nothing to say. */
  const reportedProviderNotices = new Map<string, string>();
  /** Latest doctor summary each worker sent (#1370). See WorkerView for why not a column. */
  const reportedDoctor = new Map<string, WorkerDoctorSummary>();

  /** Self-update state each worker last reported, and the workers asked to update NOW (#1338). */
  const reportedUpdates = new Map<string, WorkerUpdateReport>();
  const updateRequests = new Set<string>();

  /** What each worker said about its side of the settings (#1381): pinned keys + applied rev. */
  const reportedSettings = new Map<string, WorkerSettingsReport>();

  /**
   * Last EFFECTIVE status observed per worker, so `status_change` can be emitted on a
   * TRANSITION and only on a transition (#801).
   *
   * Why the observation happens in `listWorkersView` rather than in `heartbeat`: the
   * transition an operator actually needs after a #699/#706 failure is
   * `online -> offline`, and that one has no event to hang off — it happens when a
   * heartbeat STOPS arriving, i.e. when nobody calls anything. `effectiveStatus` is the
   * only place the board ever computes it, so this is the only honest seam. A row per
   * 30 s heartbeat would spend the whole per-worker retention budget on noise, which is
   * exactly what #774 warned about.
   *
   * The first sighting of a worker SEEDS silently: after a board restart every worker
   * would otherwise announce a transition from nothing, and "the board rebooted" is not a
   * fact about the worker.
   */
  const lastEffectiveStatus = new Map<string, WorkerStatus>();

  function noteEffectiveStatus(row: WorkerRow, current: WorkerStatus): void {
    const previous = lastEffectiveStatus.get(row.id);
    lastEffectiveStatus.set(row.id, current);
    if (previous === undefined || previous === current) return;
    void recordWorkerEvent({
      database,
      workerId: row.id,
      type: "status_change",
      summary: `worker ${row.name} went ${previous} -> ${current}`,
      payload: { from: previous, to: current, storedStatus: row.status, lastHeartbeatAt: row.lastHeartbeatAt },
    });
  }

  function mintPairingToken(now?: string): { pairingToken: string; expiresAt: string } {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    const token = pendingPairings.issue(true, { nowMs });
    return { pairingToken: token, expiresAt: new Date(nowMs + PAIRING_TOKEN_TTL_MS).toISOString() };
  }

  /** Verify AND consume a pairing token (single-use). */
  function consumePairingToken(token: string, nowMs: number): boolean {
    return pendingPairings.consume(token, nowMs) !== null;
  }

  async function registerWorker(input: RegisterWorkerInput): Promise<
    | { ok: true; workerId: string; workerToken: string; sameNamed: { id: string; lastHeartbeatAt: string | null }[] }
    | { ok: false; error: string }
  > {
    const now = input.now ?? new Date().toISOString();
    const nowMs = new Date(now).getTime();
    if (!input.name?.trim()) return { ok: false, error: "name is required" };
    if (!input.pairingToken || !consumePairingToken(input.pairingToken, nowMs)) {
      return { ok: false, error: "invalid or expired pairing token" };
    }
    // AFTER the pairing token, deliberately (#754). This endpoint is the one HTTP surface
    // the board exposes off-loopback, and version negotiation is a capability answer: an
    // unauthenticated caller must not be able to fingerprint the board's protocol range.
    // It does cost a refused worker its single-use token — acceptable, because the refusal
    // says in words that re-pairing is part of the fix.
    const compatible = checkProtocolCompatibility(input.protocolVersion);
    if (!compatible.ok) {
      console.warn(`[worker-registry] refused registration of '${input.name.trim()}': ${compatible.reason}`);
      return { ok: false, error: `${PROTOCOL_MISMATCH_PREFIX} ${compatible.reason}` };
    }
    const workerId = randomUUID();
    const workerToken = mintToken();
    // #1390: earlier rounds on the same name show as indistinguishable rows in the Runners tab;
    // name them in the answer so setup can offer to revoke the stale one.
    const sameNamed = (await workerRepo.listWorkers(database))
      .filter((w) => w.name === input.name.trim())
      .map((w) => ({ id: w.id, lastHeartbeatAt: w.lastHeartbeatAt ?? null }));
    await workerRepo.insertWorker({
      id: workerId,
      name: input.name.trim(),
      os: input.os ?? null,
      arch: input.arch ?? null,
      labels: input.labels ? JSON.stringify(input.labels) : null,
      providers: input.providers ? JSON.stringify(input.providers) : null,
      maxConcurrency: input.maxConcurrency && input.maxConcurrency > 0 ? input.maxConcurrency : 1,
      status: "online",
      tokenHash: sha256Hex(workerToken),
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    }, database);
    reportedVersions.set(workerId, {
      protocolVersion: input.protocolVersion,
      workerVersion: input.workerVersion,
    });
    // #1027: a profile-restricted project can consider this machine from registration on,
    // rather than only after its first heartbeat lands (up to 30 s later).
    noteAttestedProfiles(workerId, input.profiles);
    noteDoctor(workerId, input.doctor);
    console.log(
      `[worker-registry] registered worker: id=${workerId} name=${input.name.trim()} ` +
        `protocol=${input.protocolVersion ?? "?"} build=${input.workerVersion ?? "?"}`,
    );
    return { ok: true, workerId, workerToken, sameNamed };
  }

  /** Bearer-token check for worker-called endpoints. A revoked worker fails closed. */
  async function authenticateWorker(workerId: string, token: string): Promise<boolean> {
    if (!workerId || !token) return false;
    const row = await workerRepo.getWorkerById(workerId, database);
    if (!row) return false;
    return tokensMatch(sha256Hex(token), row.tokenHash);
  }

  async function heartbeat(
    workerId: string,
    token: string,
    opts?: {
      status?: WorkerStatus;
      now?: string;
      /** #754: re-declared every beat, so the board tracks the machine as it is now. */
      capabilities?: WorkerCapabilities;
      protocolVersion?: number;
      workerVersion?: string;
      /** #1338: the worker's self-update state. */
      update?: WorkerUpdateReport;
      /** #1381: pinned keys + last applied settings rev. */
      settingsReport?: WorkerSettingsReport;
    },
  ): Promise<{ ok: boolean; error?: string; updateNow?: boolean; config?: WorkerSettingsEnvelope }> {
    if (!(await authenticateWorker(workerId, token))) {
      return { ok: false, error: "unauthorized" };
    }
    if (opts?.status && !WORKER_STATUSES.includes(opts.status)) {
      return { ok: false, error: `invalid status: ${opts.status}` };
    }
    const now = opts?.now ?? new Date().toISOString();
    // #754: a worker that UPGRADED into incompatibility (or downgraded) must stop being a
    // placement candidate now, not in 90 s when its heartbeat happens to go stale. Marking
    // it offline is how the refusal reaches the scheduler: `eligibleWorkers` already skips
    // anything not effectively online, so no dispatch path needs to know about versions.
    if (opts && "protocolVersion" in opts) {
      const compatible = checkProtocolCompatibility(opts.protocolVersion);
      if (!compatible.ok) {
        reportedVersions.set(workerId, {
          protocolVersion: opts.protocolVersion,
          workerVersion: opts.workerVersion,
        });
        await workerRepo.updateWorkerStatus(workerId, "offline", now, database);
        console.warn(`[worker-registry] worker ${workerId} taken offline: ${compatible.reason}`);
        return { ok: false, error: `${PROTOCOL_MISMATCH_PREFIX} ${compatible.reason}` };
      }
      reportedVersions.set(workerId, {
        protocolVersion: opts.protocolVersion,
        workerVersion: opts.workerVersion,
      });
    }
    await workerRepo.updateWorkerHeartbeat(workerId, now, opts?.status, database);
    if (opts?.capabilities) {
      await workerRepo.updateWorkerCapabilities(workerId, opts.capabilities, now, database);
      // #910: capacity is volatile machine state, not a pairing fact — kept in memory like
      // protocol/version above, not persisted to the `workers` row.
      if (opts.capabilities.capacity) {
        reportedCapacity.set(workerId, opts.capabilities.capacity);
      } else {
        reportedCapacity.delete(workerId);
      }
      // #1027: re-declared every beat, so a login removed on the worker stops being a
      // permission on the board within one heartbeat rather than at the next re-pairing.
      noteAttestedProfiles(workerId, opts.capabilities.profiles);
      notePackageManagers(workerId, opts.capabilities.packageManagers);
      noteToolchains(workerId, opts.capabilities.toolchains);
      noteToolchainInstallInfo(workerId, opts.capabilities.toolchainInstall);
      noteVerify(workerId, opts.capabilities.verify);
      noteProviderNotice(workerId, opts.capabilities.providerNotice);
      noteDoctor(workerId, opts.capabilities.doctor);
    }
    if (opts?.update) {
      reportedUpdates.set(workerId, opts.update);
      // The request is delivered once the worker is on it (updating) or has given up (failed).
      if (opts.update.state !== "current") updateRequests.delete(workerId);
    }
    if (opts?.settingsReport) reportedSettings.set(workerId, opts.settingsReport);
    // #1381: the desired settings ride the heartbeat response; the worker applies by `rev`.
    const config = (await getDesiredSettings(workerId)) ?? undefined;
    return { ok: true, updateNow: updateRequests.has(workerId), ...(config ? { config } : {}) };
  }

  async function getDesiredSettings(workerId: string): Promise<WorkerSettingsEnvelope | null> {
    const row = await workerRepo.getWorkerById(workerId, database);
    return row ? parseWorkerSettingsEnvelope(row.desiredSettings) : null;
  }

  /**
   * #1381: REPLACE this worker's desired settings. Keys a worker has pinned with a flag are
   * stored anyway (so unpinning later takes effect) but are never applied by it. `drain` also
   * moves the stored status now, so placement stops/starts without waiting for the next beat.
   * Null = no such worker.
   */
  async function setDesiredSettings(
    workerId: string, settings: WorkerSettings, now?: string,
  ): Promise<{ before: WorkerSettings; envelope: WorkerSettingsEnvelope } | null> {
    const row = await workerRepo.getWorkerById(workerId, database);
    if (!row) return null;
    const at = now ?? new Date().toISOString();
    const before = parseWorkerSettingsEnvelope(row.desiredSettings)?.settings ?? {};
    const envelope: WorkerSettingsEnvelope = { rev: at, settings };
    await workerRepo.updateWorkerDesiredSettings(workerId, JSON.stringify(envelope), at, database);
    if (settings.drain === true && row.status === "online") await workerRepo.updateWorkerStatus(workerId, "draining", at, database);
    if (settings.drain !== true && before.drain === true && row.status === "draining") {
      await workerRepo.updateWorkerStatus(workerId, "online", at, database);
    }
    return { before, envelope };
  }

  /** Ask one worker to update on its next heartbeat (#1338). False = no such worker. */
  async function requestUpdate(workerId: string): Promise<boolean> {
    const row = await workerRepo.getWorkerById(workerId, database);
    if (!row) return false;
    updateRequests.add(workerId);
    return true;
  }

  /**
   * Is this an unexpired pairing token? READ-ONLY: it does not consume the token, so a fresh
   * machine can download the build with it and still pair with it afterwards (#1358). Only
   * `/build` and `/build/tarball` accept this — every other worker endpoint wants a worker token.
   */
  function isPairingTokenValid(token: string, now?: string): boolean {
    if (!token) return false;
    const nowMs = now ? new Date(now).getTime() : Date.now();
    return pendingPairings.resolve(token, nowMs) !== null;
  }

  /** Does this bearer token belong to ANY registered worker? (For endpoints with no worker id.) */
  async function authenticateAnyWorker(token: string): Promise<boolean> {
    if (!token) return false;
    const digest = sha256Hex(token);
    const rows = await workerRepo.listWorkers(database);
    let match = false;
    for (const row of rows) {
      if (tokensMatch(digest, row.tokenHash)) match = true;
    }
    return match;
  }

  async function listWorkersView(now?: string): Promise<WorkerView[]> {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    const rows = await workerRepo.listWorkers(database);
    return rows.map((row) => {
      const { tokenHash: _tokenHash, desiredSettings: _desiredSettings, ...safe } = row;
      const reported = reportedVersions.get(row.id);
      const current = effectiveStatus(row, nowMs);
      noteEffectiveStatus(row, current);
      const capacity = reportedCapacity.get(row.id);
      const profiles = reportedProfiles.get(row.id);
      const packageManagers = reportedPackageManagers.get(row.id);
      const toolchains = reportedToolchains.get(row.id);
      const toolchainInstallPolicy = reportedInstallInfo.get(row.id);
      const toolchainInstall = toolchainInstalls.get(row.id);
      const verify = reportedVerify.get(row.id);
      const providerNotice = reportedProviderNotices.get(row.id);
      const doctor = reportedDoctor.get(row.id);
      const update = reportedUpdates.get(row.id);
      const desired = parseWorkerSettingsEnvelope(row.desiredSettings);
      const settingsReport = reportedSettings.get(row.id);
      const overlay = desired ? overlaySettings(desired.settings, settingsReport) : {};
      return {
        ...safe,
        ...overlay,
        effectiveStatus: current === "online" && desired?.settings.drain === true ? "draining" : current,
        ...(desired ? { desiredSettings: desired } : {}),
        ...(settingsReport ? { settingsReport } : {}),
        ...(reported?.protocolVersion !== undefined ? { protocolVersion: reported.protocolVersion } : {}),
        ...(reported?.workerVersion !== undefined ? { workerVersion: reported.workerVersion } : {}),
        ...(capacity ? { capacity } : {}),
        ...(profiles ? { profiles } : {}),
        ...(packageManagers ? { packageManagers } : {}),
        ...(toolchains ? { toolchains } : {}),
        ...(toolchainInstallPolicy ? { toolchainInstallPolicy } : {}),
        ...(verify ? { verify } : {}),
        ...(toolchainInstall ? { toolchainInstall } : {}),
        ...(providerNotice ? { providerNotice } : {}),
        ...(doctor ? { doctor } : {}),
        ...(update ? { update } : {}),
        ...(updateRequests.has(row.id) ? { updateRequested: true } : {}),
      };
    });
  }

  /**
   * The board's desired value wins over what the worker last declared, EXCEPT for a key the
   * worker pinned with a start flag (#1381). Applied at read time because the worker's own
   * capabilities overwrite the `workers` columns on every beat, until it has applied the push.
   */
  function overlaySettings(
    settings: WorkerSettings, report: WorkerSettingsReport | undefined,
  ): Partial<Pick<WorkerRow, "labels" | "providers" | "maxConcurrency">> {
    const pinned = new Set<string>(report?.pinned ?? []);
    const out: Partial<Pick<WorkerRow, "labels" | "providers" | "maxConcurrency">> = {};
    if (settings.maxConcurrency !== undefined && !pinned.has("maxConcurrency")) out.maxConcurrency = settings.maxConcurrency;
    if (settings.labels !== undefined && !pinned.has("labels")) out.labels = JSON.stringify(settings.labels);
    if (settings.providers !== undefined && !pinned.has("providers")) out.providers = JSON.stringify(settings.providers);
    return out;
  }

  /**
   * Record (or clear) what a worker attests about its profiles (#1027).
   *
   * Deliberately a REPLACE and never a merge: the attestation is the worker's current
   * statement about itself, so a profile it stopped naming must stop being a permission.
   * Values arriving off the wire are re-parsed here rather than trusted, because both
   * callers (`hello` and the heartbeat body) hand over data from a remote machine.
   */
  function noteAttestedProfiles(workerId: string, profiles: unknown): void {
    const parsed = Array.isArray(profiles) ? parseWorkerProfileAttestations(profiles) : undefined;
    if (parsed && parsed.length > 0) reportedProfiles.set(workerId, parsed);
    else reportedProfiles.delete(workerId);
  }

  /** Record (or clear) a worker's reported package managers (#1369). A REPLACE: absent = unknown. */
  function notePackageManagers(workerId: string, raw: unknown): void {
    const parsed = parseWorkerPackageManagers(raw);
    if (parsed) reportedPackageManagers.set(workerId, parsed);
    else reportedPackageManagers.delete(workerId);
  }

  /** Record (or clear) a worker's verify capability (#1437). A REPLACE: absent = it runs no verify jobs. */
  function noteVerify(workerId: string, raw: unknown): void {
    const parsed = parseWorkerVerifyCapability(raw);
    if (parsed) reportedVerify.set(workerId, parsed);
    else reportedVerify.delete(workerId);
  }

  /** Record (or clear) a worker's detected toolchains (#1382). A REPLACE: absent = unknown. */
  function noteToolchains(workerId: string, raw: unknown): void {
    const parsed = parseWorkerToolchains(raw);
    if (parsed) reportedToolchains.set(workerId, parsed);
    else reportedToolchains.delete(workerId);
  }

  /** Record (or clear) a worker's declared toolchain install policy (#1371). A REPLACE: absent = an older worker, treated as "never". */
  function noteToolchainInstallInfo(workerId: string, raw: unknown): void {
    const parsed = parseWorkerToolchainInstallInfo(raw);
    if (parsed) reportedInstallInfo.set(workerId, parsed);
    else reportedInstallInfo.delete(workerId);
  }

  /** The board just asked this worker to install `toolchains`: a fresh record, `pending` until the worker answers. */
  function noteToolchainInstallRequested(workerId: string, requestId: string, toolchains: string[], nowMs: number = Date.now()): void {
    toolchainInstalls.set(workerId, {
      requestId, toolchains, state: "pending", reason: "requested; waiting for the worker", requestedAtMs: nowMs, updatedAtMs: nowMs,
    });
  }

  /** The worker's progress on a request. A report for a request that is no longer the current one is dropped. */
  function noteToolchainInstallStatus(workerId: string, status: ToolchainInstallStatus, nowMs: number = Date.now()): void {
    const current = toolchainInstalls.get(workerId);
    if (!current || current.requestId !== status.requestId) return;
    toolchainInstalls.set(workerId, {
      ...current, state: status.state, updatedAtMs: nowMs,
      ...(status.reason ? { reason: status.reason } : { reason: undefined }),
    });
  }

  /** Record (or clear) why a worker advertises no usable provider (#1372). A REPLACE: absent = nothing to say. */
  function noteProviderNotice(workerId: string, notice: string | undefined): void {
    if (notice) reportedProviderNotices.set(workerId, notice);
    else reportedProviderNotices.delete(workerId);
  }

  /**
   * Record a worker's doctor summary (#1370). Unlike profiles/package managers this is NOT replace-on-absent:
   * the worker sends it only when it changes, so a beat without one means unchanged, not unknown.
   */
  function noteDoctor(workerId: string, raw: unknown): void {
    const parsed = parseWorkerDoctorSummary(raw);
    if (parsed) reportedDoctor.set(workerId, parsed);
  }

  /**
   * #1396: persist what a worker declares about itself (labels, providers, max concurrency) and its
   * live capacity. Called from the socket `hello` so placement sees a restarted worker's `--labels`
   * the moment it is online, instead of from the first heartbeat up to 30 s later.
   */
  async function noteCapabilities(workerId: string, capabilities: WorkerCapabilities | undefined, now?: string): Promise<void> {
    if (!capabilities) return;
    await workerRepo.updateWorkerCapabilities(workerId, capabilities, now ?? new Date().toISOString(), database);
    if (capabilities.capacity) reportedCapacity.set(workerId, capabilities.capacity);
    else reportedCapacity.delete(workerId);
  }

  /**
   * Internal heartbeat refresh for callers that have ALREADY authenticated the
   * worker (e.g. traffic on its upgraded WebSocket). Never exposed to routes.
   */
  async function touchHeartbeat(workerId: string, now?: string, status?: WorkerStatus): Promise<void> {
    await workerRepo.updateWorkerHeartbeat(workerId, now ?? new Date().toISOString(), status, database);
  }

  /**
   * Side effects that must accompany a revocation but live outside this service:
   * closing the worker's already-upgraded WebSocket and invalidating its scoped
   * git tokens. Registered by the fleet facade AFTER the connection manager
   * exists (it is built FROM this registry, so it cannot be a constructor dep).
   */
  const revokeListeners = new Set<(workerId: string) => void | Promise<void>>();

  function onRevoke(listener: (workerId: string) => void | Promise<void>): () => void {
    revokeListeners.add(listener);
    return () => revokeListeners.delete(listener);
  }

  async function revokeWorker(workerId: string): Promise<boolean> {
    const row = await workerRepo.getWorkerById(workerId, database);
    if (!row) return false;
    await workerRepo.deleteWorker(workerId, database);
    reportedVersions.delete(workerId);
    reportedCapacity.delete(workerId);
    reportedProfiles.delete(workerId);
    reportedPackageManagers.delete(workerId);
    reportedToolchains.delete(workerId);
    reportedInstallInfo.delete(workerId);
    reportedVerify.delete(workerId);
    toolchainInstalls.delete(workerId);
    reportedProviderNotices.delete(workerId);
    reportedDoctor.delete(workerId);
    reportedUpdates.delete(workerId);
    updateRequests.delete(workerId);
    reportedSettings.delete(workerId);
    lastEffectiveStatus.delete(workerId);
    // Deleting the row only stops NEW authentications. A revoked worker also
    // holds a live socket and (for git transport) working git tokens — both must
    // die now, or "revoked" is a claim the code does not honour (#247).
    await Promise.allSettled([...revokeListeners].map(async (listener) => listener(workerId)));
    console.log(`[worker-registry] revoked worker: id=${workerId} name=${row.name}`);
    return true;
  }

  /** What the board itself speaks — surfaced so a route can report both sides (#754). */
  function boardProtocolVersion(): number {
    return WORKER_PROTOCOL_VERSION;
  }

  return {
    mintPairingToken, registerWorker, authenticateWorker, heartbeat, touchHeartbeat,
    listWorkersView, revokeWorker, onRevoke, boardProtocolVersion, noteAttestedProfiles, notePackageManagers, noteToolchains, noteToolchainInstallInfo, noteVerify, noteToolchainInstallRequested, noteToolchainInstallStatus, noteProviderNotice, noteDoctor, noteCapabilities,
    requestUpdate, authenticateAnyWorker, isPairingTokenValid, getDesiredSettings, setDesiredSettings,
  };
}

export type WorkerRegistry = ReturnType<typeof createWorkerRegistry>;

/**
 * Per-database registry instances, so the REST route and the WS route share
 * ONE pairing-token pool for a given board process while tests with their own
 * DBs stay isolated.
 */
const registryByDb = new WeakMap<object, WorkerRegistry>();

export function getWorkerRegistry(database: Database = realDb): WorkerRegistry {
  let registry = registryByDb.get(database as object);
  if (!registry) {
    registry = createWorkerRegistry(database);
    registryByDb.set(database as object, registry);
  }
  return registry;
}
