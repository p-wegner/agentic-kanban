import { useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "../lib/api.js";
import { useBacklogMarkdownLookups, type StatusRow, type TagRow } from "../hooks/useBacklogMarkdownLookups.js";
import { showToast } from "./Toast.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/**
 * Backlog Markdown — one `.md` file in and out (docs/backlog-markdown.md).
 *
 *   mode="export": pick filters, see the live count, download `<project>-backlog.md` (or copy).
 *   mode="import": paste or drop a markdown file (the kanban-md standard OR a liberal
 *                  BACKLOG.md-style file), preview what would be created / updated / left alone,
 *                  choose create-vs-update, then apply. Low parser confidence points at the
 *                  agentic path (the `backlog-markdown` skill / Butler) instead of importing junk.
 */

interface Props { projectId: string; mode: "export" | "import"; onClose: () => void }

interface PreviewRow { line: number; number: number | null; title: string; status: string; priority: string; issueType: string; tags: string[]; action: "create" | "update" | "unchanged"; matchedNumber: number | null; matchedBy: string | null; changes: string[] }
interface Preview { format: string; confidence: number; project: string | null; sameProject: boolean; mode: string; rows: PreviewRow[]; statusesToCreate: string[]; tagsToCreate: string[]; milestonesToCreate: string[]; dependencies: number; warnings: string[]; counts: { create: number; update: number; unchanged: number }; lowConfidence: boolean }
interface ImportResult { created: number; updated: number; unchanged: number; createdStatuses: string[]; createdTags: string[]; createdMilestones: string[]; createdDependencies: number; warnings: string[] }

const PRIORITIES = ["critical", "high", "medium", "low"];
const TYPES = ["feature", "bug", "task", "chore", "epic"];

export function BacklogMarkdownModal({ projectId, mode, onClose }: Props) {
  const { statuses, tags } = useBacklogMarkdownLookups(projectId);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(760px,calc(100vw-2rem))] max-h-[88vh] flex flex-col bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700" data-testid="backlog-md-modal">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {mode === "export" ? "Export backlog as Markdown" : "Import backlog from Markdown"}
          </h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none" aria-label="Close">&times;</button>
        </div>
        {mode === "export"
          ? <ExportPane projectId={projectId} statuses={statuses} tags={tags} onClose={onClose} />
          : <ImportPane projectId={projectId} onClose={onClose} />}
      </div>
    </>
  );
}

// ── export ───────────────────────────────────────────────────────────────────────────

const TERMINAL = new Set(["done", "cancelled", "canceled", "archived"]);

function ExportPane({ projectId, statuses, tags, onClose }: { projectId: string; statuses: StatusRow[]; tags: TagRow[]; onClose: () => void }) {
  const [selStatuses, setSelStatuses] = useState<Set<string> | null>(null); // null = default (non-terminal)
  const [selTags, setSelTags] = useState<Set<string>>(new Set());
  const [selPrio, setSelPrio] = useState<Set<string>>(new Set());
  const [selTypes, setSelTypes] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [since, setSince] = useState("");
  const [timestamps, setTimestamps] = useState(true);
  const [deps, setDeps] = useState(true);
  const [bare, setBare] = useState(false);
  const [preview, setPreview] = useState<{ count: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (selStatuses) p.set("status", [...selStatuses].join(","));
    else p.set("includeDone", "0");
    if (selTags.size) p.set("tag", [...selTags].join(","));
    if (selPrio.size) p.set("priority", [...selPrio].join(","));
    if (selTypes.size) p.set("type", [...selTypes].join(","));
    if (q.trim()) p.set("q", q.trim());
    if (since) p.set("since", since);
    if (!timestamps) p.set("timestamps", "0");
    if (!deps) p.set("deps", "0");
    if (bare) p.set("bare", "1");
    return p;
  }, [selStatuses, selTags, selPrio, selTypes, q, since, timestamps, deps, bare]);

  // live count via a non-download fetch (debounced)
  useEffect(() => {
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        // eslint-disable-next-line no-restricted-syntax -- the endpoint returns text/markdown, not JSON; apiFetch would try to parse it
        const res = await fetch(`/api/projects/${projectId}/backlog.md?${query.toString()}&download=0`);
        const text = await res.text();
        const m = text.match(/^issues: (\d+)$/m);
        setPreview({ count: m ? Number(m[1]) : (text.match(/^### /gm) ?? []).length, text });
      } catch { setPreview(null); } finally { setBusy(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [projectId, query]);

  const toggle = (set: Set<string>, v: string) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); return n; };
  const chip = (active: boolean) => `px-2 py-0.5 rounded-full text-[11px] border transition-colors ${active ? "bg-brand-600 border-brand-600 text-white" : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"}`;

  function download() {
    const a = document.createElement("a");
    a.href = `/api/projects/${projectId}/backlog.md?${query.toString()}&download=1`;
    a.download = "backlog.md";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    onClose();
  }
  async function copy() {
    if (!preview) return;
    try { await navigator.clipboard.writeText(preview.text); showToast(`Copied ${preview.count} issue(s) as Markdown`, "success"); }
    catch { showToast("Clipboard unavailable — use Download", "error"); }
  }

  return (
    <>
      <div className="px-4 py-3 overflow-y-auto flex-1 space-y-3 text-xs">
        <div>
          <div className="flex items-center justify-between mb-1"><span className="font-medium text-gray-700 dark:text-gray-200">Statuses</span>
            <span className="text-[11px] text-gray-400">{selStatuses ? "custom" : "default: every non-terminal column"}
              {selStatuses && <button className="ml-2 underline" onClick={() => setSelStatuses(null)}>reset</button>}</span></div>
          <div className="flex flex-wrap gap-1">
            {statuses.map((s) => { const active = selStatuses ? selStatuses.has(s.name) : !TERMINAL.has(s.name.toLowerCase());
              return <button key={s.id} type="button" className={chip(active)} onClick={() => setSelStatuses(toggle(selStatuses ?? new Set(statuses.filter((x) => !TERMINAL.has(x.name.toLowerCase())).map((x) => x.name)), s.name))}>{s.name}</button>; })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><div className="font-medium text-gray-700 dark:text-gray-200 mb-1">Priority <span className="text-gray-400 font-normal">(any)</span></div>
            <div className="flex flex-wrap gap-1">{PRIORITIES.map((p) => <button key={p} type="button" className={chip(selPrio.has(p))} onClick={() => setSelPrio(toggle(selPrio, p))}>{p}</button>)}</div></div>
          <div><div className="font-medium text-gray-700 dark:text-gray-200 mb-1">Type <span className="text-gray-400 font-normal">(any)</span></div>
            <div className="flex flex-wrap gap-1">{TYPES.map((p) => <button key={p} type="button" className={chip(selTypes.has(p))} onClick={() => setSelTypes(toggle(selTypes, p))}>{p}</button>)}</div></div>
        </div>
        {tags.length > 0 && (
          <div><div className="font-medium text-gray-700 dark:text-gray-200 mb-1">Tags <span className="text-gray-400 font-normal">(any)</span></div>
            <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto">{tags.map((t) => <button key={t.id} type="button" className={chip(selTags.has(t.name))} onClick={() => setSelTags(toggle(selTags, t.name))}>{t.name}</button>)}</div></div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="font-medium text-gray-700 dark:text-gray-200">Text contains</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} className="mt-1 w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100" placeholder="title or description…" /></label>
          <label className="block"><span className="font-medium text-gray-700 dark:text-gray-200">Updated since</span>
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="mt-1 w-full px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100" /></label>
        </div>
        <div className="flex flex-wrap gap-4 text-gray-600 dark:text-gray-300">
          <label className="flex items-center gap-1"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> created/updated dates</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={deps} onChange={(e) => setDeps(e.target.checked)} /> dependencies</label>
          <label className="flex items-center gap-1" title="No front matter / title — for pasting into an existing document"><input type="checkbox" checked={bare} onChange={(e) => setBare(e.target.checked)} /> body only</label>
        </div>
        {preview && (
          <details className="rounded border border-gray-200 dark:border-gray-700">
            <summary className="px-2 py-1 cursor-pointer text-gray-600 dark:text-gray-300">Preview ({preview.text.length.toLocaleString()} chars)</summary>
            <pre className="px-2 py-1 max-h-56 overflow-auto text-[11px] font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200">{preview.text.slice(0, 6000)}{preview.text.length > 6000 ? "\n…" : ""}</pre>
          </details>
        )}
        <p className="text-[11px] text-gray-400">Format: <code>kanban-md 1</code> — one <code>##</code> per status, one <code>###</code> per issue, a backtick metadata line. Edit the file and import it back; issues match by #number. Spec: <code>docs/backlog-markdown.md</code>.</p>
      </div>
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <span className="text-xs text-gray-500 dark:text-gray-400" data-testid="backlog-md-count">{busy ? "counting…" : preview ? `${preview.count} issue${preview.count === 1 ? "" : "s"} selected` : ""}</span>
        <div className="flex gap-2">
          <button type="button" onClick={copy} disabled={!preview} className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">Copy</button>
          <button type="button" onClick={download} className="text-xs px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700">Download .md</button>
        </div>
      </div>
    </>
  );
}

// ── import ───────────────────────────────────────────────────────────────────────────

function ImportPane({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [importMode, setImportMode] = useState<"update" | "create">("update");
  const [unknownStatus, setUnknownStatus] = useState<"create" | "map">("create");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!text.trim()) { setPreview(null); return; }
    const t = setTimeout(async () => {
      setPreviewing(true); setError(null);
      try { setPreview(await apiPost<Preview>(`/api/projects/${projectId}/backlog.md/preview`, { text, mode: importMode, unknownStatus })); }
      catch (e) { setError(errorMessage(e)); setPreview(null); }
      finally { setPreviewing(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [text, importMode, unknownStatus, projectId]);

  async function onFile(f: File | undefined) { if (!f) return; setText(await f.text()); }
  async function apply() {
    setApplying(true); setError(null);
    try {
      const r = await apiPost<ImportResult>(`/api/projects/${projectId}/backlog.md/import`, { text, mode: importMode, unknownStatus });
      setResult(r);
      showToast(`Imported: ${r.created} created, ${r.updated} updated`, "success");
    } catch (e) { setError(errorMessage(e)); } finally { setApplying(false); }
  }
  const badge = (a: PreviewRow["action"]) => a === "create" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : a === "update" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

  if (result) {
    return (
      <div className="px-4 py-4 space-y-2 text-sm">
        <p className="font-medium text-gray-900 dark:text-gray-100">Done — {result.created} created · {result.updated} updated · {result.unchanged} unchanged{result.createdDependencies ? ` · ${result.createdDependencies} dependencies` : ""}</p>
        {result.createdStatuses.length > 0 && <p className="text-xs text-gray-600 dark:text-gray-300">New statuses: {result.createdStatuses.join(", ")}</p>}
        {result.createdTags.length > 0 && <p className="text-xs text-gray-600 dark:text-gray-300">New tags: {result.createdTags.join(", ")}</p>}
        {result.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700 dark:text-amber-300">! {w}</p>)}
        <div className="pt-2 text-right"><button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700">Close</button></div>
      </div>
    );
  }
  return (
    <>
      <div className="px-4 py-3 overflow-y-auto flex-1 space-y-3 text-xs">
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={() => fileRef.current?.click()} className="px-2.5 py-1 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">Choose .md file…</button>
          <input ref={fileRef} type="file" accept=".md,.markdown,.txt" className="hidden" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
          <span className="text-gray-400">or paste below · drop a file on the box</span>
          <span className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-gray-600 dark:text-gray-300"><input type="radio" checked={importMode === "update"} onChange={() => setImportMode("update")} /> update matching</label>
            <label className="flex items-center gap-1 text-gray-600 dark:text-gray-300"><input type="radio" checked={importMode === "create"} onChange={() => setImportMode("create")} /> create all</label>
          </span>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files?.[0]); }}
          placeholder={"# My backlog\n\n## Todo\n- [ ] First thing — why it matters\n  - priority: high\n  - tags: auth\n\n## Doing\n- [ ] Second thing\n\n(or the kanban-md standard from an export)"}
          className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 font-mono text-[11px]" data-testid="backlog-md-import-text" />
        <div className="flex items-center gap-3 text-gray-600 dark:text-gray-300">
          <span>Sections the project lacks:</span>
          <label className="flex items-center gap-1"><input type="radio" checked={unknownStatus === "create"} onChange={() => setUnknownStatus("create")} /> create as new columns</label>
          <label className="flex items-center gap-1"><input type="radio" checked={unknownStatus === "map"} onChange={() => setUnknownStatus("map")} /> put in the default column</label>
        </div>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        {previewing && <p className="text-gray-400">previewing…</p>}
        {preview && (
          <div className="space-y-2" data-testid="backlog-md-preview">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`px-2 py-0.5 rounded ${badge("create")}`}>{preview.counts.create} create</span>
              <span className={`px-2 py-0.5 rounded ${badge("update")}`}>{preview.counts.update} update</span>
              <span className={`px-2 py-0.5 rounded ${badge("unchanged")}`}>{preview.counts.unchanged} unchanged</span>
              <span className="text-gray-400">· {preview.format === "kanban-md" ? "standard format" : "liberal parse"} · confidence {(preview.confidence * 100).toFixed(0)}%{preview.sameProject ? " · same project (matched by #)" : ""}</span>
            </div>
            {preview.lowConfidence && (
              <p className="px-2 py-1.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                The parser is not confident about this file. Better: ask the Butler (press <kbd>i</kbd>) to "import this backlog markdown" — it normalises the file to the standard first (skill <code>backlog-markdown</code>) and previews before writing.
              </p>
            )}
            {(preview.statusesToCreate.length > 0 || preview.tagsToCreate.length > 0 || preview.milestonesToCreate.length > 0) && (
              <p className="text-gray-600 dark:text-gray-300">
                {preview.statusesToCreate.length > 0 && <>New columns: <b>{preview.statusesToCreate.join(", ")}</b> · </>}
                {preview.tagsToCreate.length > 0 && <>New tags: <b>{preview.tagsToCreate.join(", ")}</b> · </>}
                {preview.milestonesToCreate.length > 0 && <>New milestones: <b>{preview.milestonesToCreate.join(", ")}</b></>}
              </p>
            )}
            <div className="max-h-64 overflow-auto rounded border border-gray-200 dark:border-gray-700">
              <table className="w-full text-[11px]">
                <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 sticky top-0"><tr><th className="text-left px-2 py-1">action</th><th className="text-left px-2 py-1">#</th><th className="text-left px-2 py-1">title</th><th className="text-left px-2 py-1">status</th><th className="text-left px-2 py-1">prio</th><th className="text-left px-2 py-1">changes</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.line} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="px-2 py-1"><span className={`px-1.5 rounded ${badge(r.action)}`}>{r.action}</span></td>
                      <td className="px-2 py-1 text-gray-500">{r.matchedNumber != null ? `#${r.matchedNumber}` : r.number != null ? `(#${r.number})` : "new"}</td>
                      <td className="px-2 py-1 text-gray-900 dark:text-gray-100">{r.title}{r.tags.length ? <span className="text-gray-400"> · {r.tags.join(", ")}</span> : null}</td>
                      <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{r.status}</td>
                      <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{r.priority}</td>
                      <td className="px-2 py-1 text-gray-500">{r.changes.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.warnings.map((w, i) => <p key={i} className="text-amber-700 dark:text-amber-300">! {w}</p>)}
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
        <span className="text-xs text-gray-400">Update mode changes only fields present in the file; tags and dependencies are added, never removed.</span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
          <button type="button" onClick={() => void apply()} disabled={!preview || applying || (preview.counts.create + preview.counts.update === 0)} className="text-xs px-3 py-1.5 rounded bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50" data-testid="backlog-md-apply">
            {applying ? "Importing…" : preview ? `Import (${preview.counts.create + preview.counts.update})` : "Import"}
          </button>
        </div>
      </div>
    </>
  );
}
