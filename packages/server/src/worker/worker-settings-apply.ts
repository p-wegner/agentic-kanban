/**
 * The worker's side of per-worker settings edited on the board (#1381).
 *
 * The board sends `{rev, settings}` in every heartbeat response. This applies what can change
 * live (max concurrency, labels, drain), persists the rest and the whole envelope in the state
 * file (so a restart keeps them), and reports which keys its `start` flags PIN — a pinned key is
 * never overridden by the board. Kept out of `worker-daemon.ts`, which is at its size ceiling.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  WORKER_BOARD_ONLY_SETTING_KEYS,
  WORKER_RESTART_SETTING_KEYS,
  WORKER_SETTING_KEYS,
  parseWorkerSettingsEnvelope,
  type WorkerSettingKey,
  type WorkerSettings,
  type WorkerSettingsEnvelope,
  type WorkerSettingsReport,
} from "@agentic-kanban/shared/lib/worker-settings";
import { saveProfileAliases } from "./worker-profile-aliases.js";

interface SettingsOptions {
  labels?: string[];
  providers?: string[];
  profileAliases?: string[];
  maxConcurrency?: number;
}

/** The start flags that fix a key. A flag given explicitly always beats the board. */
export function pinnedSettingKeys(opts: SettingsOptions): WorkerSettingKey[] {
  const pinned: WorkerSettingKey[] = [];
  if (opts.maxConcurrency !== undefined) pinned.push("maxConcurrency");
  if (opts.labels !== undefined) pinned.push("labels");
  if (opts.providers !== undefined) pinned.push("providers");
  if (opts.profileAliases !== undefined) pinned.push("profileAlias");
  return pinned;
}

type StateWithSettings = { settings?: Record<string, unknown>; [k: string]: unknown };

function readState(stateFile: string): StateWithSettings {
  try {
    return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  } catch {
    return {};
  }
}

export function loadPersistedSettings(stateFile: string, boardUrl: string): WorkerSettingsEnvelope | null {
  return parseWorkerSettingsEnvelope(readState(stateFile).settings?.[boardUrl]);
}

function savePersistedSettings(stateFile: string, boardUrl: string, envelope: WorkerSettingsEnvelope): void {
  const state = readState(stateFile);
  state.settings = { ...(state.settings ?? {}), [boardUrl]: envelope };
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export interface WorkerSettingsControls {
  setMaxConcurrency(n: number): void;
  setLabels(labels: string[]): void;
  /** Drain / undrain on the board's behalf. Fire-and-forget: it sends a heartbeat. */
  setDrain(on: boolean): void;
}

export interface WorkerSettingsApplier {
  /** Options with the last-persisted board settings filled in for every key no flag pins. */
  effectiveOptions<T extends SettingsOptions>(opts: T): T;
  /** The board asked for this worker to be drained and it has not been undrained since. */
  startDrained(): boolean;
  /** What to put on a heartbeat. */
  report(): WorkerSettingsReport;
  /** Apply the `config` of a heartbeat response, if it is new. */
  onHeartbeatResponse(body: unknown, controls: WorkerSettingsControls): void;
}

export function createWorkerSettingsApplier(deps: {
  opts: SettingsOptions;
  stateFile: string;
  boardUrl: string;
  log: (line: string) => void;
}): WorkerSettingsApplier {
  const { stateFile, boardUrl, log } = deps;
  const pinned = pinnedSettingKeys(deps.opts);
  const pinnedSet = new Set<string>(pinned);
  const isPinned = (key: WorkerSettingKey): boolean => pinnedSet.has(key);
  let persisted = loadPersistedSettings(stateFile, boardUrl);
  let appliedRev = persisted?.rev;
  /** Drain is ours only when the board asked for it — a self-update drain must not be undone here. */
  let drainedByBoard = persisted?.settings.drain === true && !isPinned("drain");

  function effectiveOptions<T extends SettingsOptions>(opts: T): T {
    const s = persisted?.settings;
    if (!s) return opts;
    return {
      ...opts,
      ...(!isPinned("maxConcurrency") && s.maxConcurrency !== undefined ? { maxConcurrency: s.maxConcurrency } : {}),
      ...(!isPinned("labels") && s.labels !== undefined ? { labels: s.labels } : {}),
      ...(!isPinned("providers") && s.providers !== undefined && s.providers.length > 0 ? { providers: s.providers } : {}),
    };
  }

  function applyLive(next: WorkerSettings, controls: WorkerSettingsControls): void {
    const before = persisted?.settings ?? {};
    const changed = WORKER_SETTING_KEYS.filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(next[k] ?? null));
    for (const key of changed) {
      if (WORKER_BOARD_ONLY_SETTING_KEYS.includes(key)) continue;
      if (isPinned(key)) {
        log(`[worker] board set ${key}, but a start flag pins it here, ignoring`);
        continue;
      }
      switch (key) {
        case "maxConcurrency":
          controls.setMaxConcurrency(next.maxConcurrency ?? 1);
          break;
        case "labels":
          controls.setLabels(next.labels ?? []);
          break;
        case "drain":
          if (next.drain === true) { drainedByBoard = true; controls.setDrain(true); }
          else if (drainedByBoard) { drainedByBoard = false; controls.setDrain(false); }
          break;
        case "profileAlias":
          saveProfileAliases(stateFile, next.profileAlias ?? []);
          break;
        default:
          break;
      }
      const restart = WORKER_RESTART_SETTING_KEYS.includes(key) ? " (takes effect on the next restart)" : "";
      log(`[worker] board changed ${key} -> ${JSON.stringify(next[key] ?? null)}${restart}`);
    }
  }

  return {
    effectiveOptions,
    startDrained: () => drainedByBoard,
    report: () => ({ pinned, ...(appliedRev ? { appliedRev } : {}) }),
    onHeartbeatResponse(body, controls) {
      const envelope = parseWorkerSettingsEnvelope((body as { config?: unknown } | null)?.config);
      if (!envelope || envelope.rev === appliedRev) return;
      applyLive(envelope.settings, controls);
      persisted = envelope;
      appliedRev = envelope.rev;
      savePersistedSettings(stateFile, boardUrl, envelope);
    },
  };
}
