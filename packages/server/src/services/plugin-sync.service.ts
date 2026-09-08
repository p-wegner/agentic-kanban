import {
  pluginSyncConfigPreferenceKey,
  pluginSyncStatusPreferenceKey,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginSyncDef,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { extractModelJson } from "@agentic-kanban/shared/lib/model-json";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import type { PluginRow } from "../repositories/plugins.repository.js";
import type { PluginRunContext } from "./plugin-loop-types.js";
import { runPluginCommand } from "./plugin-exec.js";
import { PluginError } from "./plugin-errors.js";

/**
 * Board-side surface over a plugin's declarative `sync` capability (#1076): per-project config
 * (site/project key/JQL/…), a validate check, and a pull/push trigger (dry-run or real) — plus the
 * board's own record of the last run, for the sync-status plugin view.
 *
 * Fails CLOSED: `validateSync`/`triggerSync` never run `pull`/`push` when a required config field
 * is empty or a declared secret is unresolvable, and they say exactly which — by NAME, never by
 * value. Secret VALUES never appear in a config read, a validation result, or a status record;
 * they are resolved from the board's own process env at trigger time only, injected as env vars
 * into the plugin's command, and discarded.
 */

export interface PluginSyncConfigFieldValue {
  key: string;
  label?: string;
  description?: string;
  required: boolean;
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

/** Best-effort structured facts a pull/push command's own stdout reported about its run. */
export interface PluginSyncRunSummary {
  counts?: { created?: number; updated?: number; skipped?: number; failed?: number };
  issues?: Array<{ externalKey: string; externalUrl?: string; localIssueNumber?: number; status?: string }>;
  conflicts?: Array<{ externalKey: string; reason: string; externalUrl?: string }>;
}

export interface PluginSyncRunRecord {
  direction: "pull" | "push";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  error?: string;
  code?: number | null;
  timedOut?: boolean;
  summary?: PluginSyncRunSummary;
}

export interface PluginSyncStatusView {
  provider: string | null;
  /** The last `validateSync` verdict, so the empty/error states can be told apart at a glance. */
  configured: boolean;
  lastRun: PluginSyncRunRecord | null;
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
  function resolveSecretPresence(sync: PluginSyncDef): PluginSyncSecretStatus[] {
    return (sync.secrets ?? []).map((name) => ({ name, present: Boolean(process.env[name]?.trim()) }));
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
        value: values[f.key] ?? "",
      })),
      secrets: resolveSecretPresence(sync),
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
      parts.push(`missing credentials: ${missingSecrets.join(", ")} (set as environment variables on the board host)`);
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
    const missingSecrets = (sync.secrets ?? []).filter((name) => !process.env[name]?.trim());
    const ok = missingConfig.length === 0 && missingSecrets.length === 0;
    return {
      ok,
      provider: sync.provider,
      missingConfig,
      missingSecrets,
      error: ok ? undefined : failClosedMessage(missingConfig, missingSecrets),
    };
  }

  /** Best-effort parse of a pull/push command's stdout as a run summary — absent when it isn't JSON. */
  function parseRunSummary(stdout: string): PluginSyncRunSummary | undefined {
    const text = stdout.trim();
    if (!text) return undefined;
    let raw: unknown;
    try {
      raw = extractModelJson(text, { shape: "object", prefer: "last" });
    } catch {
      return undefined;
    }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const rec = raw as Record<string, unknown>;
    const summary: PluginSyncRunSummary = {};
    if (rec.counts && typeof rec.counts === "object" && !Array.isArray(rec.counts)) {
      summary.counts = rec.counts as PluginSyncRunSummary["counts"];
    }
    if (Array.isArray(rec.issues)) {
      summary.issues = rec.issues
        .filter((i): i is Record<string, unknown> => i != null && typeof i === "object")
        .map((i) => ({
          externalKey: String(i.externalKey ?? ""),
          externalUrl: typeof i.externalUrl === "string" ? i.externalUrl : undefined,
          localIssueNumber: typeof i.localIssueNumber === "number" ? i.localIssueNumber : undefined,
          status: typeof i.status === "string" ? i.status : undefined,
        }))
        .filter((i) => i.externalKey);
    }
    if (Array.isArray(rec.conflicts)) {
      summary.conflicts = rec.conflicts
        .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
        .map((c) => ({
          externalKey: String(c.externalKey ?? ""),
          reason: String(c.reason ?? ""),
          externalUrl: typeof c.externalUrl === "string" ? c.externalUrl : undefined,
        }))
        .filter((c) => c.externalKey);
    }
    return summary;
  }

  async function recordSyncRun(pluginSlug: string, projectId: string, record: PluginSyncRunRecord): Promise<void> {
    await setPreferenceChecked(database, [
      { key: pluginSyncStatusPreferenceKey(pluginSlug, projectId), value: JSON.stringify(record) },
    ]);
  }

  async function getSyncStatus(pluginRowId: string, projectId: string): Promise<PluginSyncStatusView> {
    const plugin = await requirePlugin(pluginRowId);
    const sync = plugin.manifest.sync;
    await requireProject(projectId);
    const raw = await getPreference(pluginSyncStatusPreferenceKey(plugin.pluginId, projectId), database);
    let lastRun: PluginSyncRunRecord | null = null;
    if (raw) {
      try {
        lastRun = JSON.parse(raw) as PluginSyncRunRecord;
      } catch {
        lastRun = null;
      }
    }
    const configured = sync ? (await validateSync(pluginRowId, projectId)).ok : false;
    return { provider: sync?.provider ?? null, configured, lastRun };
  }

  async function triggerSync(
    pluginRowId: string,
    projectId: string,
    opts: { direction: PluginSyncDirection; dryRun?: boolean },
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
      };
      await recordSyncRun(plugin.pluginId, projectId, record);
      return record;
    }

    const values = await readSyncConfigValues(plugin.pluginId, projectId);
    const configEnv: Record<string, string> = {};
    for (const field of sync.config ?? []) {
      const v = values[field.key];
      if (v !== undefined) configEnv[`SYNC_CONFIG_${field.key.toUpperCase()}`] = v;
    }
    // Secret VALUES are resolved here, injected as env vars for this one process, and never
    // stored or echoed back — the config/status views only ever see the secret's NAME.
    const secretEnv: Record<string, string> = {};
    for (const name of sync.secrets ?? []) secretEnv[name] = process.env[name] ?? "";
    const dryRunEnv: Record<string, string> = opts.dryRun ? { SYNC_DRY_RUN: "1" } : {};

    const ctx = await resolvePluginRunContext(pluginRowId, projectId);
    const cwd = cmdDef.cwd === "repo" ? ctx.outputRepoPath : plugin.localPath;
    const env = { ...substitutePluginEnv(cmdDef.env, ctx.vars), ...configEnv, ...secretEnv, ...dryRunEnv };
    const command = substitutePluginPlaceholders(cmdDef.command, ctx.vars);

    const result = await runPluginCommand(command, { cwd, env });
    const finishedAt = new Date().toISOString();
    const ok = !result.timedOut && result.code === 0;
    const record: PluginSyncRunRecord = {
      direction: opts.direction,
      dryRun: Boolean(opts.dryRun),
      startedAt,
      finishedAt,
      ok,
      code: result.code,
      timedOut: result.timedOut || undefined,
      error: ok ? undefined : (result.timedOut ? "sync command timed out" : `sync command exited with code ${result.code}`),
      summary: parseRunSummary(result.stdout),
    };
    await recordSyncRun(plugin.pluginId, projectId, record);
    return record;
  }

  return { getSyncConfig, setSyncConfig, validateSync, triggerSync, getSyncStatus };
}
