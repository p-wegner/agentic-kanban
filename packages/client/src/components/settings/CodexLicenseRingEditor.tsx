import { useEffect, useMemo, useState } from "react";
import { apiFetch, apiPost } from "../../lib/api.js";
import { Field, type Settings, type SettingsTextSetter } from "../SettingsPanel.shared.js";

type RingMode = "oauth" | "apikey";
/** A row in the editor. `inRotation` = present in the saved ring; `autoDiscovered` =
 *  a `~/.codex-<name>` dir found on disk (selectable as a profile even when unchecked). */
type Row = {
  profile: string;
  mode: RingMode;
  path: string;
  inRotation: boolean;
  autoDiscovered: boolean;
  loggedIn?: boolean;
};

type ParsedEntry = { profile?: unknown; codexHome?: unknown; configToml?: unknown };
type DiscoveredLicense = {
  profile: string;
  mode: RingMode;
  codexHome: string | null;
  configToml: string | null;
  loggedIn: boolean;
  inRing: boolean;
  autoDiscovered: boolean;
};

function parseRing(raw: string | undefined): Row[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const e = (item ?? {}) as ParsedEntry;
      const codexHome = typeof e.codexHome === "string" ? e.codexHome : "";
      const configToml = typeof e.configToml === "string" ? e.configToml : "";
      const mode: RingMode = configToml ? "apikey" : "oauth";
      return {
        profile: typeof e.profile === "string" ? e.profile : "",
        mode,
        path: mode === "oauth" ? codexHome : configToml,
        inRotation: true,
        autoDiscovered: false,
      };
    });
  } catch {
    return [];
  }
}

/** Merge auto-discovered licenses into the ring-derived rows: mark matches, append
 *  discovered ones not yet in the ring (unchecked = visible/selectable, not rotated). */
function mergeDiscovered(rows: Row[], discovered: DiscoveredLicense[]): Row[] {
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

/** Only in-rotation rows with a name are serialized to the `codex_license_ring` pref. */
function serializeRing(rows: Row[]): string {
  const entries = rows
    .filter((r) => r.inRotation && r.profile.trim())
    .map((r) =>
      r.mode === "oauth"
        ? r.path.trim()
          ? { profile: r.profile.trim(), codexHome: r.path.trim() }
          : { profile: r.profile.trim() }
        : { profile: r.profile.trim(), configToml: r.path.trim() },
    );
  return entries.length ? JSON.stringify(entries) : "";
}

const inputClass =
  "px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white dark:bg-gray-900";
const miniBtn =
  "text-xs px-2 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 whitespace-nowrap";

/**
 * Editor for Codex licenses + the rotation ring. Auto-discovered `~/.codex-<name>`
 * logins show up here (with login status) even when they aren't in the rotation ring,
 * because they are already first-class selectable profiles. The "In rotation" checkbox
 * is what adds a license to the `codex_license_ring` pref (order + cooldown rotation).
 * OAuth rows get Login (opens a real terminal `codex login`) and Copy buttons.
 */
export function CodexLicenseRingEditor({ settings, set }: { settings: Settings; set: SettingsTextSetter }) {
  const [rows, setRows] = useState<Row[]>(() => parseRing(settings.codex_license_ring));
  const [discovered, setDiscovered] = useState<DiscoveredLicense[]>([]);
  const [home, setHome] = useState<{ homeDir: string; sep: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [launched, setLaunched] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ homeDir: string; sep: string }>("/api/preferences/home-dir").then(setHome).catch(() => setHome(null));
    apiFetch<{ licenses: DiscoveredLicense[] }>("/api/preferences/codex-licenses")
      .then((r) => {
        setDiscovered(r.licenses);
        setRows((prev) => mergeDiscovered(prev, r.licenses));
      })
      .catch(() => setDiscovered([]));
  }, []);

  // Re-sync from settings when it changes externally (initial load / save), keeping
  // the discovered licenses merged in. Skip when our own serialize already matches.
  const serialized = useMemo(() => serializeRing(rows), [rows]);
  useEffect(() => {
    const incoming = settings.codex_license_ring || "";
    if (incoming !== serialized) setRows(mergeDiscovered(parseRing(incoming), discovered));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.codex_license_ring]);

  function commit(next: Row[]) {
    setRows(next);
    set("codex_license_ring")(serializeRing(next));
  }

  function updateRow(i: number, patch: Partial<Row>) {
    commit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function resolvedHome(row: Row): string {
    if (row.path.trim()) return row.path.trim();
    if (!home || !row.profile.trim()) return "";
    return `${home.homeDir}${home.sep}.codex-${row.profile.trim()}`;
  }

  function loginCommand(row: Row): string {
    const h = resolvedHome(row);
    return h ? `$env:CODEX_HOME='${h}'; codex login` : "";
  }

  async function handleLogin(row: Row) {
    const codexHome = resolvedHome(row);
    if (!codexHome) return;
    try {
      await apiPost("/api/preferences/codex-login", { codexHome });
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

  const rotationOn = settings.codex_license_rotation !== "false";

  return (
    <Field
      label="Codex Licenses & rotation"
      hint="Any logged-in ~/.codex-<name> is auto-discovered and selectable as a Codex profile (Agent Profile dropdown + New Workspace), exactly like a toml profile. Add a row for a new OAuth login (the CODEX_HOME path is inferred from the name) and click Login. Check 'In rotation' to include a license in the rotation ring — the board falls over to the next one when a license hits its usage limit. API key = a config_<name>.toml in ~/.codex."
    >
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={rotationOn}
            onChange={(e) => set("codex_license_rotation")(e.target.checked ? "true" : "false")}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Auto-rotate to the next license on usage limit
        </label>

        {rows.length === 0 ? (
          <div className="text-xs text-gray-500 dark:text-gray-400">No Codex licenses detected. Add one below, or run `codex login` in a ~/.codex-&lt;name&gt; dir.</div>
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
                  placeholder="profile (e.g. ki14)"
                  readOnly={row.autoDiscovered}
                  className={`${inputClass} w-28 ${row.autoDiscovered ? "opacity-70" : ""}`}
                />
                {row.autoDiscovered ? (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${row.loggedIn ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"}`}
                    title={row.loggedIn ? "auth.json present" : "no auth.json — click Login"}
                  >
                    {row.loggedIn ? "logged in" : "not logged in"}
                  </span>
                ) : (
                  <select
                    value={row.mode}
                    onChange={(e) => updateRow(i, { mode: e.target.value as RingMode })}
                    className={inputClass}
                  >
                    <option value="oauth">OAuth (CODEX_HOME)</option>
                    <option value="apikey">API key (config toml)</option>
                  </select>
                )}
                <input
                  type="text"
                  value={row.path}
                  onChange={(e) => updateRow(i, { path: e.target.value })}
                  placeholder={
                    row.mode === "oauth"
                      ? row.profile.trim() && home
                        ? `${home.homeDir}${home.sep}.codex-${row.profile.trim()} (inferred)`
                        : "auto: ~/.codex-<profile>"
                      : "config_apikey1"
                  }
                  className={`${inputClass} flex-1 min-w-[10rem] font-mono`}
                />
                {row.mode === "oauth" && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleLogin(row)}
                      disabled={!resolvedHome(row)}
                      className={`${miniBtn} disabled:opacity-40`}
                      title="Open a terminal and run codex login for this license"
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
                    aria-label="Remove license"
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
          + Add license
        </button>
      </div>
    </Field>
  );
}
