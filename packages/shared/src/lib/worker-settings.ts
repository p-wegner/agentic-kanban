/**
 * Per-worker settings an operator edits on the board and the board pushes to the worker (#1381).
 *
 * Pure contract + policy (no DB, no node): the board stores `{rev, settings}` per worker, hands it
 * to the worker in the heartbeat response, and the worker applies what it can live. A flag given
 * on `worker start` PINS its key, so the board's value for it is stored but never applied — the
 * worker reports which keys are pinned and the UI shows them read-only.
 */

export const WORKER_SETTING_KEYS = [
  "maxConcurrency",
  "labels",
  "providers",
  "profileAlias",
  "allowedProjects",
  "deniedProjects",
  "drain",
  "minFreeRamGb",
] as const;
export type WorkerSettingKey = (typeof WORKER_SETTING_KEYS)[number];

/** Keys the worker can only pick up on its next start (they feed provider/profile attestation). */
export const WORKER_RESTART_SETTING_KEYS: readonly WorkerSettingKey[] = ["providers", "profileAlias"];

/** Keys enforced by the BOARD, so a worker's flags cannot pin them. */
export const WORKER_BOARD_ONLY_SETTING_KEYS: readonly WorkerSettingKey[] = ["allowedProjects", "deniedProjects", "minFreeRamGb"];

export interface WorkerSettings {
  maxConcurrency?: number;
  labels?: string[];
  /** Agent providers this worker advertises. Empty = any. */
  providers?: string[];
  /** `<source>=<name>` pairs, the shape `--profile-alias` takes. */
  profileAlias?: string[];
  /** Project ids this worker may take work for. Absent/empty = every project. */
  allowedProjects?: string[];
  /** Project ids this worker must never take work for. Wins over `allowedProjects`. */
  deniedProjects?: string[];
  drain?: boolean;
  /** #1451: the board places no new session or verify job here while the worker reports less free RAM (GB). */
  minFreeRamGb?: number;
}

/** What the board stores and sends: the settings plus a revision the worker echoes back. */
export interface WorkerSettingsEnvelope {
  rev: string;
  settings: WorkerSettings;
}

/** What a worker reports about its side on every heartbeat. */
export interface WorkerSettingsReport {
  /** Keys fixed by a `start` flag — the board's value for them is not applied. */
  pinned: WorkerSettingKey[];
  /** The `rev` of the envelope this worker last applied; absent = none yet. */
  appliedRev?: string;
}

function strings(value: unknown, max = 100): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t && t.length <= 200) seen.add(t);
    if (seen.size >= max) break;
  }
  return [...seen];
}

/** Shape-check settings off the wire or out of the DB. Ill-typed fields are dropped, never thrown on. */
export function parseWorkerSettings(raw: unknown): WorkerSettings {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: WorkerSettings = {};
  if (typeof rec.maxConcurrency === "number" && Number.isInteger(rec.maxConcurrency)
    && rec.maxConcurrency >= 1 && rec.maxConcurrency <= 64) {
    out.maxConcurrency = rec.maxConcurrency;
  }
  for (const key of ["labels", "providers", "profileAlias", "allowedProjects", "deniedProjects"] as const) {
    const list = strings(rec[key]);
    if (list) out[key] = list;
  }
  if (typeof rec.drain === "boolean") out.drain = rec.drain;
  if (typeof rec.minFreeRamGb === "number" && Number.isFinite(rec.minFreeRamGb) && rec.minFreeRamGb > 0 && rec.minFreeRamGb <= 1024) {
    out.minFreeRamGb = rec.minFreeRamGb;
  }
  return out;
}

export function parseWorkerSettingsEnvelope(raw: unknown): WorkerSettingsEnvelope | null {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return null; }
  }
  const rec = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (!rec || typeof rec.rev !== "string" || !rec.rev) return null;
  return { rev: rec.rev, settings: parseWorkerSettings(rec.settings) };
}

export function parseWorkerSettingsReport(raw: unknown): WorkerSettingsReport | undefined {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!rec) return undefined;
  const pinned = (strings(rec.pinned) ?? []).filter((k): k is WorkerSettingKey =>
    (WORKER_SETTING_KEYS as readonly string[]).includes(k) && !WORKER_BOARD_ONLY_SETTING_KEYS.includes(k as WorkerSettingKey));
  return {
    pinned,
    ...(typeof rec.appliedRev === "string" && rec.appliedRev ? { appliedRev: rec.appliedRev } : {}),
  };
}

/** The keys whose value differs between two settings objects (for the audit summary). */
export function changedSettingKeys(before: WorkerSettings, after: WorkerSettings): WorkerSettingKey[] {
  return WORKER_SETTING_KEYS.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

/** Is this worker permitted to take work for `projectId`? Deny wins; an empty allow list means everyone. */
export function workerAllowsProject(
  settings: WorkerSettings | undefined,
  projectId: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (settings?.deniedProjects?.includes(projectId)) {
    return { allowed: false, reason: "project is on this worker's denied-projects list" };
  }
  const allow = settings?.allowedProjects;
  if (allow && allow.length > 0 && !allow.includes(projectId)) {
    return { allowed: false, reason: "project is not on this worker's allowed-projects list" };
  }
  return { allowed: true };
}

/**
 * #1451: is the worker under its `minFreeRamGb` floor? A worker that has not reported free RAM is
 * never held back (unknown is not zero, as for `capacity` everywhere else); no floor = no check.
 */
export function workerBelowRamFloor(
  settings: WorkerSettings | undefined,
  freeRamGb: number | undefined,
): { below: false } | { below: true; reason: string } {
  const floor = settings?.minFreeRamGb;
  if (floor === undefined || freeRamGb === undefined || freeRamGb >= floor) return { below: false };
  return { below: true, reason: `free RAM ${freeRamGb.toFixed(1)} GB is under this worker's minFreeRamGb ${floor} GB` };
}
