import {
  pluginSyncConfigPreferenceKey,
  pluginSyncStatusPreferenceKey,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginSyncConfigFieldType,
  type PluginSyncDef,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import type { PluginSyncConnectionTest, PluginSyncRunRecord, PluginSyncStatusView } from "@agentic-kanban/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import type { PluginRow } from "../repositories/plugins.repository.js";
import type { PluginRunContext } from "./plugin-loop-types.js";
import { runPluginCommand } from "./plugin-exec.js";
import { PluginError } from "./plugin-errors.js";
import { createPluginSecretStore } from "./plugin-secret-store.js";
import { describeRunFailure, dryRunContractBreach, parseRunSummary } from "./plugin-sync-summary.js";

/**
 * Board-side surface over a plugin's declarative `sync` capability (#1076): per-project config
 * (site/project key/JQL/…), a validate check, and a pull/push trigger (dry-run or real) — plus the
 * board's own record of the last run, for the sync-status plugin view.
 *
 * Fails CLOSED: `validateSync`/`triggerSync` never run `pull`/`push` when a required config field
 * is empty or a declared secret is unresolvable, and they say exactly which — by NAME, never by
 * value. Secret VALUES never appear in a config read, a validation result, or a status record;
 * they are resolved at trigger time only — from the encrypted per-project store the settings form
 * writes (#1275), falling back to the board's own process env — injected as env vars into the
 * plugin's command, and discarded.
 */

export interface PluginSyncConfigFieldValue {
  key: string;
  label?: string;
  description?: string;
  required: boolean;
  type: PluginSyncConfigFieldType;
  value: string;
}

/** Whether the board can currently resolve one declared secret NAME — never its value. */
export interface PluginSyncSecretStatus {
  name: string;
  present: boolean;
}

export interface PluginSyncConfigView {
  provider: string;
  direction: { pull: boolean; push: boolean };
  fields: PluginSyncConfigFieldValue[];
  secrets: PluginSyncSecretStatus[];
}

export interface PluginSyncValidationResult {
  ok: boolean;
  provider: string | null;
  missingConfig: string[];
  missingSecrets: string[];
  error?: string;
}

export type { PluginSyncConnectionTest };

export type { PluginSyncRunRecord, PluginSyncStatusView };

/** #1673: one sync plugin's health for one project, as `status --watch` and ATTENTION read it. */
export interface PluginSyncHealth {
  pluginName: string;
  status: PluginSyncStatusView;
  conflicts: { count: number; oldestAt: string | null } | null;
  failures: { count: number; oldestAt: string | null } | null;
}

const SYNC_DIRECTIONS = ["pull", "push"] as const;
export type PluginSyncDirection = (typeof SYNC_DIRECTIONS)[number];

export function isPluginSyncDirection(value: unknown): value is PluginSyncDirection {
  return value === "pull" || value === "push";
}

export function createPluginSyncOps(deps: {
  database: Database;
  requirePlugin: (id: string) => Promise<PluginRow & { manifest: PluginManifest }>;
  requireProject: (projectId: string) => Promise<{ id: string; repoPath: string }>;
  resolvePluginRunContext: (
    pluginRowId: string,
    projectId: string,
    opts?: { requireScaffoldFor?: "loops" | "scripts" },
  ) => Promise<PluginRunContext>;
}) {
  const { database, requirePlugin, requireProject, resolvePluginRunContext } = deps;
  const secretStore = createPluginSecretStore({ database });

  /**
   * Every declared secret the board can resolve for this project: a value entered in the board
   * (encrypted at rest) wins, the board host's process env is the fallback for headless setups.
   */
  async function resolveSecretValues(sync: PluginSyncDef, pluginSlug: string, projectId: string): Promise<Record<string, string>> {
    const stored = await secretStore.read(pluginSlug, projectId);
    const out: Record<string, string> = {};
    for (const name of sync.secrets ?? []) {
      const value = stored[name]?.trim() || process.env[name]?.trim();
      if (value) out[name] = value;
    }
    return out;
  }

  function requireSyncDef(plugin: PluginRow & { manifest: PluginManifest }): PluginSyncDef {
    const sync = plugin.manifest.sync;
    if (!sync) throw new PluginError(`Plugin "${plugin.pluginId}" does not declare a "sync" capability`, "BAD_REQUEST");
    return sync;
  }

  async function readSyncConfigValues(pluginSlug: string, projectId: string): Promise<Record<string, string>> {
    const raw = await getPreference(pluginSyncConfigPreferenceKey(pluginSlug, projectId), database);
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Which of the sync's declared secrets the board can currently resolve — names only, never values. */
  async function resolveSecretPresence(sync: PluginSyncDef, pluginSlug: string, projectId: string): Promise<PluginSyncSecretStatus[]> {
    const resolved = await resolveSecretValues(sync, pluginSlug, projectId);
    return (sync.secrets ?? []).map((name) => ({ name, present: name in resolved }));
  }

  /**
   * The env a plugin subprocess gets from the board's sync settings: `SYNC_CONFIG_<KEY>` per
   * config field plus every resolved secret under its declared name. `secretValues` lets the
   * caller redact them from captured output.
   */
  async function resolveSyncEnv(
    plugin: PluginRow & { manifest: PluginManifest },
    projectId: string,
  ): Promise<{ env: Record<string, string>; secretValues: string[] }> {
    const sync = plugin.manifest.sync;
    if (!sync) return { env: {}, secretValues: [] };
    const values = await readSyncConfigValues(plugin.pluginId, projectId);
    const env: Record<string, string> = {};
    for (const field of sync.config ?? []) {
      const v = values[field.key];
      if (v !== undefined) env[`SYNC_CONFIG_${field.key.toUpperCase()}`] = v;
    }
    // Secret VALUES are injected for this one process and never stored or echoed back — the
    // config/status views only ever see the secret's NAME.
    const secrets = await resolveSecretValues(sync, plugin.pluginId, projectId);
    Object.assign(env, secrets);
    return { env, secretValues: Object.values(secrets) };
  }

  /** Masks every secret value in captured process output. */
  function redactSecrets(text: string, secretValues: string[]): string {
    let out = text;
    for (const value of secretValues) if (value.length >= 4) out = out.split(value).join("***");
    return out;
  }

  /**
   * Stores secret VALUES entered in the board (encrypted at rest). MERGES onto what is stored;
   * an empty string clears that one secret. Returns the same name-only view as `getSyncConfig`.
   */
  async function setSyncSecrets(
    pluginRowId: string,
    projectId: string,
    values: Record<string, unknown>,
  ): Promise<PluginSyncConfigView> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = requireSyncDef(plugin);
    await requireProject(projectId);
    const declared = new Set(sync.secrets ?? []);
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!declared.has(key)) {
        throw new PluginError(`"${key}" is not a declared sync secret for "${plugin.pluginId}"`, "BAD_REQUEST");
      }
      if (typeof value !== "string") throw new PluginError(`sync secret "${key}" must be a string`, "BAD_REQUEST");
      clean[key] = value.trim();
    }
    await secretStore.write(plugin.pluginId, projectId, clean);
    return getSyncConfig(pluginRowId, projectId);
  }

  async function getSyncConfig(pluginRowId: string, projectId: string): Promise<PluginSyncConfigView> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = requireSyncDef(plugin);
    await requireProject(projectId);
    const values = await readSyncConfigValues(plugin.pluginId, projectId);
    return {
      provider: sync.provider,
      direction: { pull: Boolean(sync.pull), push: Boolean(sync.push) },
      fields: (sync.config ?? []).map((f) => ({
        key: f.key,
        label: f.label,
        description: f.description,
        required: Boolean(f.required),
        type: f.type ?? "text",
        value: values[f.key] ?? "",
      })),
      secrets: await resolveSecretPresence(sync, plugin.pluginId, projectId),
    };
  }

  /**
   * MERGES `values` onto the project's existing config — never a full overwrite. A settings
   * form submits every field at once, but the CLI's `config-set <plugin> <key> <value>` sets
   * ONE field per call; a full-overwrite semantics would silently erase every other field on
   * the very next call.
   */
  async function setSyncConfig(
    pluginRowId: string,
    projectId: string,
    values: Record<string, unknown>,
  ): Promise<PluginSyncConfigView> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = requireSyncDef(plugin);
    await requireProject(projectId);
    const declaredKeys = new Set((sync.config ?? []).map((f) => f.key));
    const merged = await readSyncConfigValues(plugin.pluginId, projectId);
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!declaredKeys.has(key)) {
        throw new PluginError(`"${key}" is not a declared sync config field for "${plugin.pluginId}"`, "BAD_REQUEST");
      }
      if (typeof value !== "string") {
        throw new PluginError(`sync config "${key}" must be a string`, "BAD_REQUEST");
      }
      merged[key] = value;
    }
    await setPreferenceChecked(database, [
      { key: pluginSyncConfigPreferenceKey(plugin.pluginId, projectId), value: JSON.stringify(merged) },
    ]);
    return getSyncConfig(pluginRowId, projectId);
  }

  function failClosedMessage(missingConfig: string[], missingSecrets: string[]): string {
    const parts: string[] = [];
    if (missingConfig.length) parts.push(`missing required config: ${missingConfig.join(", ")}`);
    if (missingSecrets.length) {
      parts.push(`missing credentials: ${missingSecrets.join(", ")} (enter them in the plugin's settings, or set them as environment variables on the board host)`);
    }
    return `Sync is not configured — ${parts.join("; ")}.`;
  }

  async function validateSync(pluginRowId: string, projectId: string): Promise<PluginSyncValidationResult> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = requireSyncDef(plugin);
    await requireProject(projectId);
    const values = await readSyncConfigValues(plugin.pluginId, projectId);
    const missingConfig = (sync.config ?? [])
      .filter((f) => f.required && !values[f.key]?.trim())
      .map((f) => f.key);
    const resolvedSecrets = await resolveSecretValues(sync, plugin.pluginId, projectId);
    const missingSecrets = (sync.secrets ?? []).filter((name) => !(name in resolvedSecrets));
    const ok = missingConfig.length === 0 && missingSecrets.length === 0;
    return {
      ok,
      provider: sync.provider,
      missingConfig,
      missingSecrets,
      error: ok ? undefined : failClosedMessage(missingConfig, missingSecrets),
    };
  }

  /** The stored record: the latest run, plus the latest run PER DIRECTION under `runs` (#1625). */
  type StoredRun = PluginSyncRunRecord & { runs?: { pull?: PluginSyncRunRecord; push?: PluginSyncRunRecord } };

  async function readStoredRun(pluginSlug: string, projectId: string): Promise<StoredRun | null> {
    const raw = await getPreference(pluginSyncStatusPreferenceKey(pluginSlug, projectId), database);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed != null && typeof parsed === "object" ? (parsed as StoredRun) : null;
    } catch {
      return null;
    }
  }

  async function recordSyncRun(pluginSlug: string, projectId: string, record: PluginSyncRunRecord): Promise<void> {
    const previous = await readStoredRun(pluginSlug, projectId);
    const { runs: previousRuns, ...previousLatest } = previous ?? ({} as StoredRun);
    const runs = {
      ...(previousRuns ?? (previous?.direction ? { [previous.direction]: previousLatest as PluginSyncRunRecord } : {})),
      [record.direction]: record,
    };
    await setPreferenceChecked(database, [
      { key: pluginSyncStatusPreferenceKey(pluginSlug, projectId), value: JSON.stringify({ ...record, runs }) },
    ]);
  }

  /** Minutes between scheduled runs; blank / non-numeric / <= 0 = off. */
  function parseEveryMinutes(raw: string | undefined): number {
    const n = Math.floor(Number(raw?.trim()));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** The plugin's state dir, found via the push command's `*_STATE_DIR` env. Null when it cannot be resolved. */
  async function resolveStateDir(
    plugin: PluginRow & { manifest: PluginManifest },
    pluginRowId: string,
    projectId: string,
  ): Promise<string | null> {
    const pushEnv = plugin.manifest.sync?.push?.env;
    if (!pushEnv) return null;
    try {
      const ctx = await resolvePluginRunContext(pluginRowId, projectId);
      const env = substitutePluginEnv(pushEnv, ctx.vars);
      const dirKey = Object.keys(env).find((k) => k.endsWith("_STATE_DIR"));
      return dirKey ? env[dirKey]! : null;
    } catch {
      return null;
    }
  }

  /** Queued entries in the plugin's outbox. Null when unreadable. */
  async function readOutboxLength(
    plugin: PluginRow & { manifest: PluginManifest },
    pluginRowId: string,
    projectId: string,
  ): Promise<number | null> {
    const dir = await resolveStateDir(plugin, pluginRowId, projectId);
    if (!dir) return null;
    try {
      const file = join(dir, "outbox.json");
      if (!existsSync(file)) return 0;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: unknown };
      return Array.isArray(parsed.entries) ? parsed.entries.length : null;
    } catch {
      return null;
    }
  }

  /** Unresolved entries of a conflict/failure register (#1673): how many, and when the oldest was detected. */
  function readOpenRegister(dir: string | null, fileName: string): { count: number; oldestAt: string | null } | null {
    if (!dir) return null;
    try {
      const file = join(dir, fileName);
      if (!existsSync(file)) return { count: 0, oldestAt: null };
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, { resolved?: boolean; detectedAt?: string }> };
      const open = Object.values(parsed.entries ?? {}).filter((e) => e && !e.resolved);
      const times = open.map((e) => e.detectedAt).filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t))).sort();
      return { count: open.length, oldestAt: times[0] ?? null };
    } catch {
      return null;
    }
  }

  /** Everything `status --watch` shows for one (sync plugin, project): stored run summaries plus the local registers. No Jira calls. */
  async function getSyncHealth(pluginRowId: string, projectId: string): Promise<PluginSyncHealth> {
    const plugin = await requirePlugin(pluginRowId);
    const status = await getSyncStatus(pluginRowId, projectId);
    const dir = await resolveStateDir(plugin, pluginRowId, projectId);
    return {
      pluginName: plugin.manifest.name ?? plugin.pluginId,
      status,
      conflicts: readOpenRegister(dir, "conflict-register.json"),
      failures: readOpenRegister(dir, "failure-register.json"),
    };
  }

  async function getSyncStatus(pluginRowId: string, projectId: string): Promise<PluginSyncStatusView> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = plugin.manifest.sync;
    await requireProject(projectId);
    const stored = await readStoredRun(plugin.pluginId, projectId);
    const { runs, ...latest } = stored ?? ({} as StoredRun);
    const lastRun = stored ? (latest as PluginSyncRunRecord) : null;
    const lastRuns = {
      pull: runs?.pull ?? (lastRun?.direction === "pull" ? lastRun : null),
      push: runs?.push ?? (lastRun?.direction === "push" ? lastRun : null),
    };
    const configured = sync ? (await validateSync(pluginRowId, projectId)).ok : false;
    const values = await readSyncConfigValues(plugin.pluginId, projectId);
    return {
      provider: sync?.provider ?? null,
      configured,
      lastRun,
      lastRuns,
      outboxLength: sync ? await readOutboxLength(plugin, pluginRowId, projectId) : null,
      schedule: {
        pullEveryMinutes: parseEveryMinutes(values.pullEveryMinutes),
        pushEveryMinutes: parseEveryMinutes(values.pushEveryMinutes),
      },
    };
  }

  async function triggerSync(
    pluginRowId: string,
    projectId: string,
    opts: { direction: PluginSyncDirection; dryRun?: boolean; scheduled?: boolean },
  ): Promise<PluginSyncRunRecord> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = requireSyncDef(plugin);
    if (!isPluginSyncDirection(opts.direction)) {
      throw new PluginError('"direction" must be "pull" or "push"', "BAD_REQUEST");
    }
    const cmdDef = opts.direction === "pull" ? sync.pull : sync.push;
    if (!cmdDef) {
      throw new PluginError(`Plugin "${plugin.pluginId}" does not declare a "${opts.direction}" sync command`, "BAD_REQUEST");
    }
    await requireProject(projectId);

    const startedAt = new Date().toISOString();
    const scheduled = opts.scheduled || undefined;
    // Fail CLOSED: refuse to run pull/push at all when config/secrets are incomplete, and record
    // that refusal as this project's last run so the status view shows WHY nothing happened.
    const validation = await validateSync(pluginRowId, projectId);
    if (!validation.ok) {
      const record: PluginSyncRunRecord = {
        direction: opts.direction,
        dryRun: Boolean(opts.dryRun),
        startedAt,
        finishedAt: startedAt,
        ok: false,
        error: validation.error,
        scheduled,
      };
      await recordSyncRun(plugin.pluginId, projectId, record);
      return record;
    }

    const { env: syncEnv, secretValues } = await resolveSyncEnv(plugin, projectId);
    const dryRunEnv: Record<string, string> = opts.dryRun ? { SYNC_DRY_RUN: "1" } : {};

    const ctx = await resolvePluginRunContext(pluginRowId, projectId);
    const cwd = cmdDef.cwd === "repo" ? ctx.outputRepoPath : plugin.localPath;
    const env = { ...substitutePluginEnv(cmdDef.env, ctx.vars), ...syncEnv, ...dryRunEnv };
    const command = substitutePluginPlaceholders(cmdDef.command, ctx.vars);

    const raw = await runPluginCommand(command, { cwd, env });
    const result = { ...raw, stdout: redactSecrets(raw.stdout, secretValues), stderr: redactSecrets(raw.stderr, secretValues) };
    const finishedAt = new Date().toISOString();
    // A dry run that reports a created Jira key wrote for real: fail it loudly (#1634).
    const breach = opts.dryRun ? dryRunContractBreach(result.stdout) : undefined;
    const ok = !result.timedOut && result.code === 0 && !breach;
    const record: PluginSyncRunRecord = {
      direction: opts.direction,
      dryRun: Boolean(opts.dryRun),
      startedAt,
      finishedAt,
      ok,
      code: result.code,
      timedOut: result.timedOut || undefined,
      // The script's own `step`/`reason` and the stderr tail, not just the exit code (#1625).
      error: ok ? undefined : (breach ?? describeRunFailure(result)),
      scheduled,
      summary: parseRunSummary(result.stdout, { siteUrl: syncEnv.SYNC_CONFIG_SITEURL }),
    };
    await recordSyncRun(plugin.pluginId, projectId, record);
    return record;
  }

  /**
   * Settle ONE diverged issue on an agent's behalf (#1643). The agent has no Jira credentials; the
   * board runs the plugin's `sync.resolve` command with them injected, so the secret never leaves
   * the board. No `keep` = read-only: the three-way field table (board / last sync / Jira now).
   * `keep: "jira"` overwrites the board issue from Jira, `keep: "board"` writes the board's
   * mapped fields to Jira once. Fails closed on incomplete config, like `triggerSync`.
   */
  async function resolveSyncIssue(
    pluginRowId: string,
    projectId: string,
    opts: { key: string; keep?: "board" | "jira" },
  ): Promise<{ ok: boolean; mode: "show" | "keep"; key: string; keep?: string; result?: unknown; error?: string }> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = requireSyncDef(plugin);
    if (!sync.resolve) {
      throw new PluginError(`Plugin "${plugin.pluginId}" does not declare a "sync.resolve" command`, "BAD_REQUEST");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(opts.key ?? "")) {
      throw new PluginError('"key" must be an external issue key such as "KD-49"', "BAD_REQUEST");
    }
    if (opts.keep != null && opts.keep !== "board" && opts.keep !== "jira") {
      throw new PluginError('"keep" must be "board" or "jira"', "BAD_REQUEST");
    }
    await requireProject(projectId);
    const mode = opts.keep ? "keep" : "show";
    const validation = await validateSync(pluginRowId, projectId);
    if (!validation.ok) return { ok: false, mode, key: opts.key, keep: opts.keep, error: validation.error };

    const { env: syncEnv, secretValues } = await resolveSyncEnv(plugin, projectId);
    const ctx = await resolvePluginRunContext(pluginRowId, projectId);
    const cwd = sync.resolve.cwd === "repo" ? ctx.outputRepoPath : plugin.localPath;
    const env = {
      ...substitutePluginEnv(sync.resolve.env, ctx.vars),
      ...syncEnv,
      SYNC_RESOLVE_KEY: opts.key,
      ...(opts.keep ? { SYNC_RESOLVE_KEEP: opts.keep } : {}),
    };
    const raw = await runPluginCommand(substitutePluginPlaceholders(sync.resolve.command, ctx.vars), { cwd, env });
    const stdout = redactSecrets(raw.stdout, secretValues);
    let parsed: unknown = null;
    try { parsed = JSON.parse(stdout); } catch { parsed = stdout.trim() || null; }
    const ok = !raw.timedOut && raw.code === 0;
    return {
      ok,
      mode,
      key: opts.key,
      keep: opts.keep,
      result: parsed,
      error: ok ? undefined : describeRunFailure({ ...raw, stdout, stderr: redactSecrets(raw.stderr, secretValues) }),
    };
  }

  const runningSchedules = new Set<string>();

  /**
   * The scheduler tick (#1625): for every (plugin, project) pair, run each direction whose
   * `<direction>EveryMinutes` config says it is due, measured from the start of that direction's
   * last run (failed or not, so a broken sync is retried at its cadence rather than hammered).
   * A pair that is not fully configured is skipped silently: nothing to run, nothing to record.
   */
  async function runDueSyncSchedules(
    targets: Array<{ pluginRowId: string; projectId: string }>,
    nowMs: number = Date.now(),
  ): Promise<Array<{ pluginRowId: string; projectId: string; direction: PluginSyncDirection; ok: boolean }>> {
    const fired: Array<{ pluginRowId: string; projectId: string; direction: PluginSyncDirection; ok: boolean }> = [];
    for (const { pluginRowId, projectId } of targets) {
      let status: PluginSyncStatusView;
      try {
        status = await getSyncStatus(pluginRowId, projectId);
      } catch {
        continue;
      }
      if (!status.configured) continue;
      for (const direction of SYNC_DIRECTIONS) {
        const every = direction === "pull" ? status.schedule.pullEveryMinutes : status.schedule.pushEveryMinutes;
        if (every <= 0) continue;
        const last = status.lastRuns[direction];
        // A dry run doesn't count as the sync having happened.
        if (last && !last.dryRun && nowMs - Date.parse(last.startedAt) < every * 60_000) continue;
        const key = `${pluginRowId}:${projectId}:${direction}`;
        if (runningSchedules.has(key)) continue;
        runningSchedules.add(key);
        try {
          const record = await triggerSync(pluginRowId, projectId, { direction, scheduled: true });
          fired.push({ pluginRowId, projectId, direction, ok: record.ok });
        } catch {
          fired.push({ pluginRowId, projectId, direction, ok: false });
        } finally {
          runningSchedules.delete(key);
        }
      }
    }
    return fired;
  }

  return { getSyncConfig, setSyncConfig, setSyncSecrets, validateSync, triggerSync, resolveSyncIssue, getSyncStatus, getSyncHealth, runDueSyncSchedules, resolveSyncEnv, redactSecrets };
}
