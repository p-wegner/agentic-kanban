import { useCallback, useEffect, useState } from "react";
import { apiFetch, apiPost } from "../../lib/api.js";
import { showToast } from "../../lib/toast.js";

type SyncConfigView = {
  provider: string;
  fields: Array<{ key: string; label?: string; description?: string; required: boolean; value: string }>;
  secrets: Array<{ name: string; present: boolean }>;
};

type ConnectionTest = {
  ok: boolean;
  error?: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const INPUT_CLASS =
  "flex-1 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 dark:bg-gray-800 dark:text-gray-200";

/**
 * Generic settings form for a plugin's manifest `sync.config` + `sync.secrets` (#1275). Config
 * fields prefill from the board's stored values; secret inputs are write-only (the server
 * only ever reports whether one is set), so a typed value is sent once and the field cleared.
 */
export function PluginSyncSettings({ pluginRowId, projectId }: { pluginRowId: string; projectId: string }) {
  const base = `/api/plugins/${pluginRowId}/sync`;
  const [view, setView] = useState<SyncConfigView | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ConnectionTest | null>(null);

  const load = useCallback(async () => {
    const next = await apiFetch<SyncConfigView>(`${base}/config?projectId=${encodeURIComponent(projectId)}`);
    setView(next);
    setFieldValues(Object.fromEntries(next.fields.map((f) => [f.key, f.value])));
  }, [base, projectId]);

  useEffect(() => {
    setView(null);
    setTest(null);
    setSecretValues({});
    load().catch((err) => showToast(err instanceof Error ? err.message : "Could not load sync settings", "error"));
  }, [load]);

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      await apiPost(`${base}/config`, { projectId, values: fieldValues });
      const typed = Object.fromEntries(Object.entries(secretValues).filter(([, v]) => v.trim() !== ""));
      if (Object.keys(typed).length > 0) await apiPost(`${base}/secrets`, { projectId, values: typed });
      setSecretValues({});
      await load();
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function clearSecret(name: string) {
    try {
      await apiPost(`${base}/secrets`, { projectId, values: { [name]: "" } });
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not clear secret", "error");
    }
  }

  async function testConnection() {
    setTesting(true);
    setTest(null);
    try {
      // Save first so the test runs against exactly what the form shows.
      if (!(await save())) return;
      setTest(await apiPost<ConnectionTest>(`${base}/test-connection`, { projectId }));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Test failed", "error");
    } finally {
      setTesting(false);
    }
  }

  if (!view) return <div className="text-[11px] text-gray-400">Loading sync settings…</div>;

  return (
    <div className="space-y-1.5" data-testid="plugin-sync-settings">
      {view.fields.map((f) => (
        <label key={f.key} className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-xs text-gray-700 dark:text-gray-300">
            {f.label ?? f.key}{f.required ? " *" : ""}
          </span>
          <input
            type="text"
            value={fieldValues[f.key] ?? ""}
            placeholder={f.description}
            onChange={(e) => setFieldValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className={INPUT_CLASS}
            data-testid={`plugin-sync-field-${f.key}`}
          />
        </label>
      ))}
      {view.secrets.map((s) => (
        <label key={s.name} className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-xs font-mono text-gray-700 dark:text-gray-300">{s.name}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={secretValues[s.name] ?? ""}
            placeholder={s.present ? "set — type to replace" : "not set"}
            onChange={(e) => setSecretValues((v) => ({ ...v, [s.name]: e.target.value }))}
            className={INPUT_CLASS}
            data-testid={`plugin-sync-secret-${s.name}`}
          />
          {s.present && (
            <button type="button" onClick={() => void clearSecret(s.name)} className="text-[11px] text-gray-400 hover:text-red-600">
              Clear
            </button>
          )}
        </label>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void save().then((ok) => ok && showToast("Sync settings saved", "success"))}
          disabled={saving || testing}
          className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          data-testid="plugin-sync-save"
        >
          {saving && !testing ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={saving || testing}
          className="text-xs px-2 py-1 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
          data-testid="plugin-sync-test"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <span className="text-[11px] text-gray-400 dark:text-gray-500">
          Secrets are stored encrypted in kanban.db, never in the repo or the profile.
        </span>
      </div>
      {test && (
        <div
          className={`text-xs rounded border p-2 ${test.ok
            ? "border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
            : "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"}`}
          data-testid="plugin-sync-test-result"
        >
          <div className="font-medium">{test.ok ? "Connection OK" : `Connection failed${test.error ? ` — ${test.error}` : ""}`}</div>
          {(test.stdout || test.stderr) && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px]">
              {[test.stdout, test.stderr].filter(Boolean).join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
