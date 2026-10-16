// #1443 - worker lifecycle: persisted start args (`config set|unset`) and the `status` view.
//
// Start flags that PIN a setting (#1381) used to live only in argv, and a self-update restart reuses
// the old argv, so removing `--max-concurrency 2` took an extra manual restart. The state file now
// carries `startConfig`: `set` values override argv, `unset` keys drop the argv flag. Applied by
// `worker start` on every (self-)restart. Db-free: ships in the standalone worker binary.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadUndelivered } from "./worker-undelivered.js";
import type { VerifyJobStatus } from "./worker-verify-runner.js";
import type { WorkerSettingKey, WorkerSettings } from "@agentic-kanban/shared/lib/worker-settings";
import type { WorkerControlHandlers } from "./worker-control.js";
import { freeDiskGb, readWorkerCapacity } from "./worker-resources.js";
import { evaluateWorkerConcurrency } from "@agentic-kanban/shared/lib/worker-concurrency";

export const START_CONFIG_KEYS = ["maxConcurrency", "verifySlots", "labels", "providers", "profileAlias"] as const;
export type StartConfigKey = (typeof START_CONFIG_KEYS)[number];

/** The `start` flag behind each key; the key is also the `worker start` option property it fills. */
const KEY_FLAG: Record<StartConfigKey, string> = {
  maxConcurrency: "--max-concurrency",
  verifySlots: "--verify-slots",
  labels: "--labels",
  providers: "--providers",
  profileAlias: "--profile-alias",
};

export interface StartConfig {
  set: Partial<Record<StartConfigKey, string>>;
  unset: StartConfigKey[];
}

export function isStartConfigKey(key: string): key is StartConfigKey {
  return (START_CONFIG_KEYS as readonly string[]).includes(key);
}

function readRaw(stateFile: string): Record<string, unknown> {
  try {
    return existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadStartConfig(stateFile: string): StartConfig {
  const raw = readRaw(stateFile).startConfig as Partial<StartConfig> | undefined;
  const set: StartConfig["set"] = {};
  for (const [k, v] of Object.entries(raw?.set ?? {})) if (isStartConfigKey(k) && typeof v === "string") set[k] = v;
  return { set, unset: (raw?.unset ?? []).filter((k): k is StartConfigKey => typeof k === "string" && isStartConfigKey(k)) };
}

function saveStartConfig(stateFile: string, cfg: StartConfig): void {
  const state = readRaw(stateFile);
  state.startConfig = cfg;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/** `config set <key> <value>`: returns an error message, or null when saved. */
export function setStartConfig(stateFile: string, key: string, value: string | undefined): string | null {
  if (!isStartConfigKey(key)) return `unknown key '${key}' (one of: ${START_CONFIG_KEYS.join(", ")})`;
  if (value === undefined) return `config set ${key} needs a value`;
  if (key === "maxConcurrency" && (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > 64)) {
    return "maxConcurrency must be a whole number between 1 and 64";
  }
  if (key === "verifySlots" && (!/^\d+$/.test(value.trim()) || Number(value) < 1 || Number(value) > 16)) {
    return "verifySlots must be a whole number between 1 and 16";
  }
  const cfg = loadStartConfig(stateFile);
  cfg.set[key] = value.trim();
  cfg.unset = cfg.unset.filter((k) => k !== key);
  saveStartConfig(stateFile, cfg);
  return null;
}

/** `config unset <key>`: the start flag stops pinning the key; the board's value applies again. */
export function unsetStartConfig(stateFile: string, key: string): string | null {
  if (!isStartConfigKey(key)) return `unknown key '${key}' (one of: ${START_CONFIG_KEYS.join(", ")})`;
  const cfg = loadStartConfig(stateFile);
  delete cfg.set[key];
  if (!cfg.unset.includes(key)) cfg.unset.push(key);
  saveStartConfig(stateFile, cfg);
  return null;
}

interface StartConfigurable {
  maxConcurrency?: number;
  verifySlots?: number;
  labels?: string;
  providers?: string;
  profileAlias?: string;
}

/** Fold the persisted start config over the parsed `start` options (set wins over argv; unset drops it). */
export function applyStartConfig<T extends StartConfigurable>(options: T, stateFile: string): T {
  const cfg = loadStartConfig(stateFile);
  const out: StartConfigurable = { ...options };
  for (const key of cfg.unset) out[key] = undefined;
  for (const [key, value] of Object.entries(cfg.set) as [StartConfigKey, string][]) {
    if (key === "maxConcurrency") out.maxConcurrency = Number(value);
    else if (key === "verifySlots") out.verifySlots = Number(value);
    else out[key] = value;
  }
  return out as T;
}

// --- status -----------------------------------------------------------------------------------

export interface LifecycleCtx {
  stateFile: string;
  workRoot: string;
  boardUrl: string;
  draining(): boolean;
  sessionsLeft(): number;
  effective(): { maxConcurrency?: number; verifySlots?: number; labels?: string[]; providers?: string[]; profileAliases?: string[] };
  pinned(): WorkerSettingKey[];
  desired(): WorkerSettings | undefined;
  /** #1451: attested provider:profile pairs and the harness mode (absent on older callers). */
  profiles?(): string[];
  harnessMode?(): string | undefined;
  /** #1479: verify slots and in-flight job ids. */
  verify?(): { slots: number; freeSlots: number; ramGb: number; jobIds?: string[]; jobs?: VerifyJobStatus[] };
}

export interface StatusSetting {
  key: StartConfigKey;
  effective?: unknown;
  desired?: unknown;
  /** Present when a start flag or `config set` pins the key. */
  pinnedBy?: string;
}

export function buildLifecycleDetails(ctx: LifecycleCtx): Record<string, unknown> {
  const eff = ctx.effective();
  const desired = ctx.desired();
  const cfg = loadStartConfig(ctx.stateFile);
  const pinned = new Set<string>(ctx.pinned());
  const value: Record<StartConfigKey, unknown> = {
    maxConcurrency: desired?.maxConcurrency === "auto" && !pinned.has("maxConcurrency") ? "auto" : eff.maxConcurrency,
    verifySlots: eff.verifySlots,
    labels: eff.labels,
    providers: eff.providers,
    profileAlias: eff.profileAliases,
  };
  const settings: StatusSetting[] = START_CONFIG_KEYS.map((key) => ({
    key,
    effective: value[key],
    ...(key !== "verifySlots" && desired?.[key] !== undefined ? { desired: desired[key] } : {}),
    ...(pinned.has(key) ? { pinnedBy: key in cfg.set ? `config set ${key}` : KEY_FLAG[key] } : {}),
  }));
  const GB = 1024 ** 3;
  const resources = { freeRamGb: freemem() / GB, totalRamGb: totalmem() / GB, freeDiskGb: freeDiskGb(ctx.workRoot) };
  // #1456: mode, derived slots and why, from THIS machine's own numbers (the board derives from the same heartbeat).
  const concurrency = evaluateWorkerConcurrency({
    declaredSlots: eff.maxConcurrency ?? 1, pinned: pinned.has("maxConcurrency"),
    capacity: readWorkerCapacity(ctx.workRoot), settings: desired,
  });
  return {
    concurrency,
    draining: ctx.draining(),
    sessionsLeft: ctx.sessionsLeft(),
    stateFile: ctx.stateFile,
    workRoot: ctx.workRoot,
    settings,
    profiles: ctx.profiles?.() ?? [],
    harnessMode: ctx.harnessMode?.(),
    resources, // #1451
    ...(ctx.verify ? { verify: ctx.verify() } : {}), // #1479
    daemonNode: process.version,
    sessionsNode: probeNodeOnPath(),
    undelivered: loadUndelivered(ctx.workRoot).map((r) => ({
      sessionId: r.sessionId,
      branch: r.branch,
      checkoutPath: r.checkoutPath,
      attempts: r.attempts,
      lastError: r.lastError,
      recordedAt: r.recordedAt,
    })),
  };
}

/** #1461: the Node a session's PATH resolves (what agents run), or null when there is none. Never throws. */
export function probeNodeOnPath(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const r = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true, env, shell: process.platform === "win32" });
    const out = String(r.stdout ?? "").trim();
    return r.status === 0 && out ? out : null;
  } catch {
    return null;
  }
}

const show = (v: unknown): string => (v === undefined ? "default" : Array.isArray(v) ? v.join(",") || "none" : String(v));

export function renderStatus(s: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`build:        ${(s.workerVersion as string | undefined) ?? "unknown"}`);
  lines.push(`pid:          ${String(s.pid ?? "?")}   board: ${String(s.boardUrl ?? "?")}`);
  const left = Number(s.sessionsLeft ?? 0);
  lines.push(`state:        ${s.draining ? "draining" : "online"}, ${left} session(s) ${s.draining ? "left" : "running"}`);
  const upd = s.update as { state?: string; reason?: string } | undefined;
  if (upd?.state && upd.state !== "current") lines.push(`update:       ${upd.state}${upd.reason ? ` (${upd.reason})` : ""}`);
  if (s.daemonNode !== undefined || s.sessionsNode !== undefined) {
    const d = String(s.daemonNode ?? "unknown");
    const n = s.sessionsNode ? String(s.sessionsNode) : "none on PATH";
    lines.push(`node:         daemon ${d}, sessions ${n}${s.sessionsNode && s.sessionsNode !== d ? "  (differ - restart the daemon from a shell with the wanted Node first on PATH)" : ""}`);
  }
  const held = (s.undelivered as { sessionId: string; branch: string; checkoutPath: string; attempts: number; lastError?: string }[] | undefined) ?? [];
  if (held.length > 0) {
    lines.push(`undelivered:  ${held.length} result(s) not yet on the board`);
    for (const r of held) {
      lines.push(`  ${r.sessionId} branch ${r.branch} (${r.attempts} attempt(s)) checkout ${r.checkoutPath}${r.lastError ? ` - ${r.lastError}` : ""}`);
    }
  }
  lines.push(`state file:   ${String(s.stateFile ?? "?")}`);
  lines.push(`work root:    ${String(s.workRoot ?? "?")}`);
  const profiles = s.profiles as string[] | undefined;
  if (profiles) lines.push(`profiles:     ${profiles.length > 0 ? profiles.join(", ") : "none attested"}`);
  if (s.harnessMode) lines.push(`harness:      ${String(s.harnessMode)}`);
  const res = s.resources as { freeRamGb?: number; totalRamGb?: number; freeDiskGb?: number } | undefined;
  if (res) {
    const gb = (v?: number): string => (v === undefined ? "?" : `${v.toFixed(1)} GB`);
    lines.push(`ram:          ${gb(res.freeRamGb)} free of ${gb(res.totalRamGb)}`);
    lines.push(`disk:         ${gb(res.freeDiskGb)} free (work root)`);
  }
  const conc = s.concurrency as { mode?: string; slots?: number; reason?: string } | undefined;
  const vs = (s.settings as StatusSetting[] | undefined)?.find((x) => x.key === "verifySlots");
  const vjobs = (s.verify as { jobs?: VerifyJobStatus[] } | undefined)?.jobs ?? [];
  for (const j of vjobs) {
    const files = j.filesTotal ? ` ${j.filesDone ?? 0}/${j.filesTotal} files` : j.filesDone ? ` ${j.filesDone} files` : "";
    lines.push(`verify job:   ${j.jobId.slice(0, 8)} ${j.tier} @ ${String(j.sha).slice(0, 9)} ${j.stage}${files} (since ${j.startedAt})`);
  }
  if (vs?.effective !== undefined) lines.push(`verify slots: ${String(vs.effective)}`);
  if (conc?.mode) lines.push(`concurrency:  ${conc.mode}, ${conc.slots ?? "?"} slot(s) - ${conc.reason ?? ""}`);
  lines.push("settings:");
  for (const st of (s.settings as StatusSetting[] | undefined) ?? []) {
    let text: string;
    if (st.pinnedBy) {
      text = st.desired !== undefined && show(st.desired) !== show(st.effective)
        ? `desired ${show(st.desired)}, pinned ${show(st.effective)} by ${st.pinnedBy}`
        : `${show(st.effective)} (pinned by ${st.pinnedBy})`;
    } else {
      text = `${show(st.effective)} (${st.desired !== undefined ? "from the board" : "default, unpinned"})`;
    }
    lines.push(`  ${st.key.padEnd(15)}${text}`);
  }
  return lines.join("\n");
}

/** What `worker start` hands the daemon for its control endpoint (status details + stop/restart). */
export type LifecycleHandlers = Pick<WorkerControlHandlers, "details" | "shutdown">;
