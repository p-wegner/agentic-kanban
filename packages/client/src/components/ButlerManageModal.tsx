import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import { modelOptionsForBackend } from "../lib/butler-format.js";

export interface ButlerDef { id: string; name: string; model: string; provider?: "claude" | "codex" | null; }

const PROVIDER_OPTIONS: { value: "claude" | "codex"; label: string }[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

/** Modal for managing the global set of butlers: add, rename, set model, remove. Capped server-side. */
export function ButlerManageModal({ globalBackend, onClose, onChanged }: { globalBackend: "claude" | "codex"; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<ButlerDef[]>([]);
  const [max, setMax] = useState(4);
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newProvider, setNewProvider] = useState<"claude" | "codex">(globalBackend);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      const r = await apiFetch<{ butlers: ButlerDef[]; max: number }>("/api/butler-definitions");
      setItems(r.butlers);
      setMax(r.max);
      onChanged();
    } catch { /* ignore */ }
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }

  async function callDef(path: string, init: { method: string; body?: unknown }) {
    const res = await fetch(`/api/butler-definitions${path}`, {
      method: init.method,
      headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    return data;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-surface dark:bg-surface-dark border border-gray-200 dark:border-gray-700 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-800">
          <h3 className="text-sm font-semibold text-ink dark:text-stone-100">Manage butlers</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none">×</button>
        </div>
        <div className="px-5 py-4 space-y-2 max-h-[60vh] overflow-y-auto">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Butlers are shared across all projects; each keeps its own warm conversation per project. Up to {max}.
          </p>
          {items.map((b) => {
            const itemProvider: "claude" | "codex" = b.provider ?? globalBackend;
            const itemModelOptions = modelOptionsForBackend(itemProvider);
            return (
              <div key={b.id} className="flex items-center gap-2">
                <input
                  defaultValue={b.name}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== b.name) void run(() => callDef(`/${b.id}`, { method: "PUT", body: { name: v } })); }}
                  disabled={busy}
                  className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <select
                  value={itemProvider}
                  onChange={(e) => void run(() => callDef(`/${b.id}`, { method: "PUT", body: { provider: e.target.value, model: "" } }))}
                  disabled={busy}
                  title="Provider for this butler"
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {PROVIDER_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <select
                  value={b.model}
                  onChange={(e) => void run(() => callDef(`/${b.id}`, { method: "PUT", body: { model: e.target.value } }))}
                  disabled={busy}
                  className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  {itemModelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <button
                  onClick={() => void run(() => callDef(`/${b.id}`, { method: "DELETE" }))}
                  disabled={busy || b.id === "default"}
                  title={b.id === "default" ? "The default butler can't be removed" : "Remove this butler"}
                  className="text-gray-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-gray-400 px-1"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" /></svg>
                </button>
              </div>
            );
          })}
          {items.length < max && (
            <div className="flex items-center gap-2 pt-2 border-t border-gray-100 dark:border-gray-800 mt-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New butler name (e.g. Quick)"
                disabled={busy}
                className="flex-1 min-w-0 rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-2 py-1 text-sm text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <select
                value={newProvider}
                onChange={(e) => { setNewProvider(e.target.value as "claude" | "codex"); setNewModel(""); }}
                disabled={busy}
                title="Provider for the new butler"
                className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                {PROVIDER_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <select value={newModel} onChange={(e) => setNewModel(e.target.value)} disabled={busy} className="rounded border border-gray-300 dark:border-gray-600 bg-surface-raised dark:bg-surface-raised-dark px-1.5 py-1 text-xs text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-brand-500">
                {modelOptionsForBackend(newProvider).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <button
                onClick={() => { if (newName.trim()) void run(async () => { await callDef("", { method: "POST", body: { name: newName.trim(), model: newModel, provider: newProvider } }); setNewName(""); setNewModel(""); setNewProvider(globalBackend); }); }}
                disabled={busy || !newName.trim()}
                className="px-3 py-1 rounded bg-brand-600 hover:bg-brand-700 text-white text-xs font-medium disabled:opacity-50"
              >
                Add
              </button>
            </div>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
