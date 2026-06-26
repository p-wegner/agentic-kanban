import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiPost } from "../../lib/api.js";
import { Field, type Settings, type SettingsTextSetter } from "../SettingsPanel.shared.js";

/**
 * Shared editor for a provider auth-rotation ring (Claude subscriptions /
 * CLAUDE_CONFIG_DIR, Codex licenses / CODEX_HOME). The two are the same UI: a
 * rotation toggle plus a list of rows, each an OAuth login pinned to a config
 * directory or an API-key login selected by a settings/config profile, with a
 * Login/Copy action and auto-discovered logins merged in. They differ only in
 * preference keys, API endpoints, the stored JSON field names, env var, dir
 * prefix, and copy. `ClaudeSubscriptionRingEditor` / `CodexLicenseRingEditor`
 * are thin wrappers that supply a `RingEditorConfig`. The shared service-side
 * mechanism lives in server `auth-rotation-ring.ts`.
 */

type RingMode = "oauth" | "apikey";

/** A row in the editor. `inRotation` = present in the saved ring; `autoDiscovered` =
 *  a `~/<prefix><name>` dir found on disk (selectable as a profile even when unchecked). */
type Row = {
  profile: string;
  mode: RingMode;
  path: string;
  inRotation: boolean;
  autoDiscovered: boolean;
  loggedIn?: boolean;
};

/** A login surfaced by the discover endpoint. Only profile/mode/loggedIn/autoDiscovered
 *  are consumed here; provider-specific path fields ride along but are unused. */
type DiscoveredLogin = {
  profile: string;
  mode: RingMode;
  loggedIn: boolean;
  inRing: boolean;
  autoDiscovered: boolean;
};

type ParsedEntry = { profile?: unknown } & Record<string, unknown>;

export interface RingEditorConfig {
  /** Settings key holding the serialized ring JSON, e.g. "claude_subscription_ring". */
  ringSettingKey: keyof Settings & string;
  /** Settings key for the rotation on/off toggle. */
  rotationSettingKey: keyof Settings & string;
  /** GET endpoint returning discovered logins. */
  discoverEndpoint: string;
  /** Property on the discover response holding the array, e.g. "subscriptions" / "licenses". */
  discoverResponseKey: string;
  /** POST endpoint that opens a terminal for `<tool> login`. */
  loginEndpoint: string;
  /** Body property carrying the config dir on the login POST, e.g. "configDir" / "codexHome". */
  loginBodyKey: string;
  /** Stored-JSON field name for an OAuth config dir, e.g. "configDir" / "codexHome". */
  dirField: string;
  /** Stored-JSON field name for an API-key profile, e.g. "settingsProfile" / "configToml". */
  apiKeyField: string;
  /** Home-relative dir prefix, e.g. ".claude-" / ".codex-". */
  dirPrefix: string;
  /** Env var the login command sets, e.g. "CLAUDE_CONFIG_DIR" / "CODEX_HOME". */
  envVar: string;
  /** The `<tool> login` invocation, e.g. "claude /login" / "codex login". */
  loginInvocation: string;
  /** Lower-case singular noun: "subscription" / "license". */
  noun: string;
  /** Capitalized provider+noun for the field label, e.g. "Claude Subscriptions". */
  fieldLabel: string;
  /** The long explanatory hint under the field label. */
  hint: string;
  /** Auth file shown in the logged-in badge tooltip, e.g. ".credentials.json" / "auth.json". */
  authFileLabel: string;
  /** Example profile name in the profile input placeholder, e.g. "max2" / "ki14". */
  profileExample: string;
  /** Label for the API-key dropdown option, e.g. "API key (settings json)". */
  apiKeyOptionLabel: string;
  /** Placeholder for the path input in API-key mode, e.g. "settings profile name". */
  apiKeyPlaceholder: string;
}

function parseRing(cfg: RingEditorConfig, raw: string | undefined): Row[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const e = (item ?? {}) as ParsedEntry;
      const dir = typeof e[cfg.dirField] === "string" ? (e[cfg.dirField] as string) : "";
      const apiKey = typeof e[cfg.apiKeyField] === "string" ? (e[cfg.apiKeyField] as string) : "";
      const mode: RingMode = apiKey ? "apikey" : "oauth";
      return {
        profile: typeof e.profile === "string" ? e.profile : "",
        mode,
        path: mode === "oauth" ? dir : apiKey,
        inRotation: true,
        autoDiscovered: false,
      };
    });
  } catch {
    return [];
  }
}

/** Merge auto-discovered logins into the ring-derived rows: mark matches, append
 *  discovered ones not yet in the ring (unchecked = visible/selectable, not rotated). */
function mergeDiscovered(rows: Row[], discovered: DiscoveredLogin[]): Row[] {
  const byProfile = new Map(rows.map((r) => [r.profile, { ...r }]));
  for (const d of discovered) {
    const existing = byProfile.get(d.profile);
    if (existing) {
      existing.autoDiscovered = existing.autoDiscovered || d.autoDiscovered;
      existing.loggedIn = d.loggedIn;
    } else {
      byProfile.set(d.profile, {
        profile: d.profile, mode: d.mode, path: "",
        inRotation: false, autoDiscovered: d.autoDiscovered, loggedIn: d.loggedIn,
      });
    }
  }
  // Auto-discovered first (sorted), then manual ring-only rows in their order.
  const all = [...byProfile.values()];
  const auto = all.filter((r) => r.autoDiscovered).sort((a, b) => a.profile.localeCompare(b.profile));
  const manual = all.filter((r) => !r.autoDiscovered);
  return [...auto, ...manual];
}

/** Only in-rotation rows with a name are serialized to the ring pref. */
function serializeRing(cfg: RingEditorConfig, rows: Row[]): string {
  const entries = rows
    .filter((r) => r.inRotation && r.profile.trim())
    .map((r) =>
      r.mode === "oauth"
        ? r.path.trim()
          ? { profile: r.profile.trim(), [cfg.dirField]: r.path.trim() }
          : { profile: r.profile.trim() }
        : { profile: r.profile.trim(), [cfg.apiKeyField]: r.path.trim() },
    );
  return entries.length ? JSON.stringify(entries) : "";
}

const inputClass =
  "px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900";
const miniBtn =
  "text-xs px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 whitespace-nowrap";

export function ProviderRotationRingEditor({
  config: cfg,
  settings,
  set,
}: {
  config: RingEditorConfig;
  settings: Settings;
  set: SettingsTextSetter;
}) {
  const [rows, setRows] = useState<Row[]>(() => parseRing(cfg, settings[cfg.ringSettingKey]));
  const [discovered, setDiscovered] = useState<DiscoveredLogin[]>([]);
  const [home, setHome] = useState<{ homeDir: string; sep: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [launched, setLaunched] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ homeDir: string; sep: string }>("/api/preferences/home-dir").then(setHome).catch(() => setHome(null));
    apiFetch<Record<string, DiscoveredLogin[]>>(cfg.discoverEndpoint)
      .then((r) => {
        const list = r[cfg.discoverResponseKey] ?? [];
        setDiscovered(list);
        setRows((prev) => mergeDiscovered(prev, list));
      })
      .catch(() => setDiscovered([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync from settings when it changes externally (initial load / save), keeping
  // the discovered logins merged in. Skip when our own serialize already matches.
  const serialized = useMemo(() => serializeRing(cfg, rows), [cfg, rows]);
  useEffect(() => {
    const incoming = settings[cfg.ringSettingKey] || "";
    if (incoming !== serialized) setRows(mergeDiscovered(parseRing(cfg, incoming), discovered));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings[cfg.ringSettingKey]]);

  function commit(next: Row[]) {
    setRows(next);
    set(cfg.ringSettingKey)(serializeRing(cfg, next));
  }

  function updateRow(i: number, patch: Partial<Row>) {
    commit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function resolvedDir(row: Row): string {
    if (row.path.trim()) return row.path.trim();
    if (!home || !row.profile.trim()) return "";
    return `${home.homeDir}${home.sep}${cfg.dirPrefix}${row.profile.trim()}`;
  }

  function loginCommand(row: Row): string {
    const d = resolvedDir(row);
    return d ? `$env:${cfg.envVar}='${d}'; ${cfg.loginInvocation}` : "";
  }

  async function handleLogin(row: Row) {
    const dir = resolvedDir(row);
    if (!dir) return;
    try {
      await apiPost(cfg.loginEndpoint, { [cfg.loginBodyKey]: dir });
      setLaunched(row.profile);
      setTimeout(() => setLaunched((cur) => (cur === row.profile ? null : cur)), 4000);
    } catch { /* user can use Copy and run it manually */ }
  }

  async function handleCopy(row: Row) {
    const cmd = loginCommand(row);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(row.profile);
      setTimeout(() => setCopied((cur) => (cur === row.profile ? null : cur)), 2000);
    } catch { /* clipboard blocked */ }
  }

  const rotationOn = settings[cfg.rotationSettingKey] !== "false";

  return (
    <Field label={`${cfg.fieldLabel} & rotation`} hint={cfg.hint}>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={rotationOn}
            onChange={(e) => set(cfg.rotationSettingKey)(e.target.checked ? "true" : "false")}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Auto-rotate to the next {cfg.noun} on usage limit
        </label>

        {rows.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            No {cfg.fieldLabel} detected. Add one below, or run `{cfg.loginInvocation}` in a ~/{cfg.dirPrefix}&lt;name&gt; dir.
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={`${row.profile}-${i}`} className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400" title="Include in the rotation ring">
                  <input
                    type="checkbox"
                    checked={row.inRotation}
                    onChange={(e) => updateRow(i, { inRotation: e.target.checked })}
                    className="rounded border-gray-300 dark:border-gray-600"
                  />
                  rotate
                </label>
                <input
                  type="text"
                  value={row.profile}
                  onChange={(e) => updateRow(i, { profile: e.target.value })}
                  placeholder={`profile (e.g. ${cfg.profileExample})`}
                  readOnly={row.autoDiscovered}
                  className={`${inputClass} w-28 ${row.autoDiscovered ? "opacity-70" : ""}`}
                />
                {row.autoDiscovered ? (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${row.loggedIn ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}
                    title={row.loggedIn ? `${cfg.authFileLabel} present` : `no ${cfg.authFileLabel} — click Login`}
                  >
                    {row.loggedIn ? "logged in" : "not logged in"}
                  </span>
                ) : (
                  <select
                    value={row.mode}
                    onChange={(e) => updateRow(i, { mode: e.target.value as RingMode })}
                    className={inputClass}
                  >
                    <option value="oauth">OAuth ({cfg.envVar})</option>
                    <option value="apikey">{cfg.apiKeyOptionLabel}</option>
                  </select>
                )}
                <input
                  type="text"
                  value={row.path}
                  onChange={(e) => updateRow(i, { path: e.target.value })}
                  placeholder={
                    row.mode === "oauth"
                      ? row.profile.trim() && home
                        ? `${home.homeDir}${home.sep}${cfg.dirPrefix}${row.profile.trim()} (inferred)`
                        : `auto: ~/${cfg.dirPrefix}<profile>`
                      : cfg.apiKeyPlaceholder
                  }
                  className={`${inputClass} flex-1 min-w-[10rem] font-mono`}
                />
                {row.mode === "oauth" && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleLogin(row)}
                      disabled={!resolvedDir(row)}
                      className={`${miniBtn} disabled:opacity-40`}
                      title={`Open a terminal and run ${cfg.loginInvocation} for this ${cfg.noun}`}
                    >
                      {launched === row.profile ? "Terminal opened" : "Login"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleCopy(row)}
                      disabled={!loginCommand(row)}
                      className={`${miniBtn} disabled:opacity-40`}
                      title="Copy the manual login command"
                    >
                      {copied === row.profile ? "Copied" : "Copy"}
                    </button>
                  </>
                )}
                {!row.autoDiscovered && (
                  <button
                    type="button"
                    onClick={() => commit(rows.filter((_, idx) => idx !== i))}
                    className={miniBtn}
                    aria-label={`Remove ${cfg.noun}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => commit([...rows, { profile: "", mode: "oauth", path: "", inRotation: true, autoDiscovered: false }])}
          className="text-xs px-2.5 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          + Add {cfg.noun}
        </button>
      </div>
    </Field>
  );
}
