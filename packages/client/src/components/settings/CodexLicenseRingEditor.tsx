import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../lib/api.js";
import { Field, type Settings, type SettingsTextSetter } from "../SettingsPanel.shared.js";

type RingMode = "oauth" | "apikey";
type RingRow = { profile: string; mode: RingMode; path: string };

type ParsedEntry = { profile?: unknown; codexHome?: unknown; configToml?: unknown };

function parseRing(raw: string | undefined): RingRow[] {
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
      };
    });
  } catch {
    return [];
  }
}

function serializeRing(rows: RingRow[]): string {
  const entries = rows
    .filter((r) => r.profile.trim())
    .map((r) =>
      r.mode === "oauth"
        // Empty path → omit codexHome so the server infers ~/.codex-<profile>.
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
 * Structured editor for the `codex_license_ring` preference. Each row maps a Codex
 * profile name to a "license": an OAuth ChatGPT login (its own CODEX_HOME dir) or an
 * API-key config toml in ~/.codex. The board rotates to the next row when one hits its
 * usage limit. Serializes to the JSON-string pref on every change.
 *
 * For OAuth rows the CODEX_HOME path is inferred from the profile name
 * (`<home>/.codex-<profile>`) — the path field is just an optional override. A Login
 * button opens a real terminal running `codex login` against that dir; a Copy button
 * yields the manual command.
 */
export function CodexLicenseRingEditor({ settings, set }: { settings: Settings; set: SettingsTextSetter }) {
  const [rows, setRows] = useState<RingRow[]>(() => parseRing(settings.codex_license_ring));
  const [home, setHome] = useState<{ homeDir: string; sep: string } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [launched, setLaunched] = useState<number | null>(null);

  useEffect(() => {
    apiFetch<{ homeDir: string; sep: string }>("/api/preferences/home-dir")
      .then(setHome)
      .catch(() => setHome(null));
  }, []);

  // Re-sync from settings when it changes externally (initial load / save), but not
  // when our own serialize matches — avoids clobbering an in-progress edit / cursor jump.
  const serialized = useMemo(() => serializeRing(rows), [rows]);
  useEffect(() => {
    const incoming = settings.codex_license_ring || "";
    if (incoming !== serialized) setRows(parseRing(incoming));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.codex_license_ring]);

  function commit(next: RingRow[]) {
    setRows(next);
    set("codex_license_ring")(serializeRing(next));
  }

  function updateRow(i: number, patch: Partial<RingRow>) {
    commit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  /** Effective CODEX_HOME for an OAuth row: explicit override, else inferred default. */
  function resolvedHome(row: RingRow): string {
    if (row.path.trim()) return row.path.trim();
    if (!home || !row.profile.trim()) return "";
    return `${home.homeDir}${home.sep}.codex-${row.profile.trim()}`;
  }

  function loginCommand(row: RingRow): string {
    const h = resolvedHome(row);
    return h ? `$env:CODEX_HOME='${h}'; codex login` : "";
  }

  async function handleLogin(i: number) {
    const codexHome = resolvedHome(rows[i]);
    if (!codexHome) return;
    try {
      await apiFetch("/api/preferences/codex-login", {
        method: "POST",
        body: JSON.stringify({ codexHome }),
      });
      setLaunched(i);
      setTimeout(() => setLaunched((cur) => (cur === i ? null : cur)), 4000);
    } catch {
      // Non-fatal: the user can use the Copy button and run it manually.
    }
  }

  async function handleCopy(i: number) {
    const cmd = loginCommand(rows[i]);
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(i);
      setTimeout(() => setCopied((cur) => (cur === i ? null : cur)), 2000);
    } catch {
      // clipboard blocked — no-op
    }
  }

  const rotationOn = settings.codex_license_rotation !== "false";

  return (
    <Field
      label="Codex Licenses (rotation ring)"
      hint="The rotation order: the board falls over to the next account when one hits its usage limit. OAuth = a ChatGPT login; give it a profile name and the CODEX_HOME dir is inferred (~/.codex-<profile>) — click Login to authenticate. Any logged-in ~/.codex-<name> is auto-discovered as a selectable Codex profile (Agent Profile dropdown above + New Workspace), exactly like a toml profile, even without a row here — rows here just set the rotation order. API key = a config_<name>.toml in ~/.codex."
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
          <div className="text-xs text-gray-500 dark:text-gray-400">No licenses configured. Add one below.</div>
        ) : (
          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={row.profile}
                    onChange={(e) => updateRow(i, { profile: e.target.value })}
                    placeholder="profile (e.g. ki14)"
                    className={`${inputClass} w-32`}
                  />
                  <select
                    value={row.mode}
                    onChange={(e) => updateRow(i, { mode: e.target.value as RingMode })}
                    className={inputClass}
                  >
                    <option value="oauth">OAuth (CODEX_HOME)</option>
                    <option value="apikey">API key (config toml)</option>
                  </select>
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
                    className={`${inputClass} flex-1 min-w-[12rem] font-mono`}
                  />
                  {row.mode === "oauth" && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleLogin(i)}
                        disabled={!resolvedHome(row)}
                        className={`${miniBtn} disabled:opacity-40`}
                        title="Open a terminal and run codex login for this license"
                      >
                        {launched === i ? "Terminal opened" : "Login"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCopy(i)}
                        disabled={!loginCommand(row)}
                        className={`${miniBtn} disabled:opacity-40`}
                        title="Copy the manual login command"
                      >
                        {copied === i ? "Copied" : "Copy"}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => commit(rows.filter((_, idx) => idx !== i))}
                    className={miniBtn}
                    aria-label="Remove license"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => commit([...rows, { profile: "", mode: "oauth", path: "" }])}
          className="text-xs px-2.5 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          + Add license
        </button>
      </div>
    </Field>
  );
}
