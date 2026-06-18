import { useState, useRef, useEffect } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { showToast } from "./Toast.js";

type ImportFormat = "auto" | "csv" | "markdown";

interface PreviewRow {
  row: number;
  title: string;
  description: string;
  priority: string;
  issueType: string;
  estimate: string;
}
interface SkippedRow {
  row: number;
  title: string;
  reason: string;
}
interface WarningRow {
  row: number;
  title: string;
  field: string;
  message: string;
}
interface PreviewResult {
  format: string;
  rows: PreviewRow[];
  skipped: SkippedRow[];
  warnings: WarningRow[];
  parseErrors: string[];
}
interface ImportResult {
  created: number;
  skipped: number;
  skippedRows: SkippedRow[];
  parseErrors: string[];
  warnings: WarningRow[];
}

interface ImportIssuesModalProps {
  projectId: string;
  onClose: () => void;
}

const FORMAT_OPTIONS: { value: ImportFormat; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "csv", label: "CSV" },
  { value: "markdown", label: "Markdown" },
];

const FORMAT_HINT: Record<ImportFormat, string> = {
  auto: "Detected from content.",
  csv: "Header row required (title, description, priority, type).",
  markdown: "One issue per top-level bullet (- or *); indented sub-bullets become the description.",
};

export function ImportIssuesModal({ projectId, onClose }: ImportIssuesModalProps) {
  const [text, setText] = useState("");
  const [format, setFormat] = useState<ImportFormat>("auto");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Live preview: re-parse (server-side, single source of truth) shortly after
  // the text or format settles. The commit endpoint re-parses the same text, so
  // what the user sees is exactly what gets created.
  useEffect(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const id = window.setTimeout(() => {
      apiPost<PreviewResult>(`/api/projects/${projectId}/issues/import/preview`, { text, format })
        .then((r) => { setPreview(r); })
        .catch(() => { setPreview(null); })
        .finally(() => setPreviewing(false));
    }, 350);
    return () => window.clearTimeout(id);
  }, [text, format, projectId]);

  // Escape to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !committing) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, committing]);

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    file
      .text()
      .then((t) => {
        setText(t);
        const name = file.name.toLowerCase();
        if (name.endsWith(".csv")) setFormat("csv");
        else if (name.endsWith(".md") || name.endsWith(".markdown")) setFormat("markdown");
        else if (name.endsWith(".json")) setFormat("auto");
      })
      .catch(() => showToast("Could not read file", "error"));
  }

  async function handleCreate() {
    if (!preview || preview.rows.length === 0 || committing) return;
    setCommitting(true);
    try {
      const res = await apiPost<ImportResult>(`/api/projects/${projectId}/issues/import`, { text, format });
      setResult(res);
      if (res.created > 0) {
        showToast(`Imported ${res.created} issue${res.created === 1 ? "" : "s"} into Backlog`, "success");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Import failed", "error");
    } finally {
      setCommitting(false);
    }
  }

  const validCount = preview?.rows.length ?? 0;
  const skippedCount = preview?.skipped.length ?? 0;
  const warningCount = preview?.warnings.length ?? 0;

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={() => !committing && onClose()} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(680px,calc(100vw-2rem))] max-h-[85vh] flex flex-col bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Import issues</h3>
          <button
            type="button"
            onClick={() => !committing && onClose()}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {result ? (
          <ImportResultView result={result} onClose={onClose} />
        ) : (
          <>
            <div className="px-4 py-3 overflow-y-auto flex-1 space-y-3">
              {/* Format selector */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-600 dark:text-gray-400">Format:</span>
                <div className="flex rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden">
                  {FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormat(opt.value)}
                      className={`px-2.5 py-1 text-xs transition-colors ${
                        format === opt.value
                          ? "bg-brand-600 text-white"
                          : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-gray-400 dark:text-gray-500">{FORMAT_HINT[format]}</span>
              </div>

              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"Paste CSV or Markdown here…\n\nCSV:\ntitle,description,priority,type\nAdd search,Full-text search,high,feature\n\nMarkdown:\n- Add search\n  - Needs an index\n- Fix N+1 queries"}
                rows={8}
                className="w-full text-xs font-mono border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500 resize-y dark:bg-gray-800 dark:text-gray-100"
              />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 bg-surface-raised dark:bg-surface-raised-dark text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800 flex items-center gap-1.5"
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 8l5-5 5 5M12 3v12" />
                  </svg>
                  Upload file (.csv, .md, .json)
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.md,.markdown,.json,text/csv,text/markdown,application/json"
                  className="hidden"
                  onChange={handleFile}
                />
                {previewing && (
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 flex items-center gap-1">
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Parsing…
                  </span>
                )}
              </div>

              {/* Preview */}
              {preview && text.trim() && (
                <div className="space-y-2">
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-gray-600 dark:text-gray-400">
                      Detected: <span className="font-medium">{preview.format}</span>
                    </span>
                    <span className="text-emerald-600 dark:text-emerald-400">{validCount} valid</span>
                    {skippedCount > 0 && (
                      <span className="text-amber-500">{skippedCount} skipped</span>
                    )}
                    {warningCount > 0 && (
                      <span className="text-amber-500">{warningCount} warning{warningCount === 1 ? "" : "s"}</span>
                    )}
                    {preview.parseErrors.length > 0 && (
                      <span className="text-red-500">{preview.parseErrors.length} parse error{preview.parseErrors.length === 1 ? "" : "s"}</span>
                    )}
                  </div>

                  {preview.rows.length > 0 && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-md overflow-hidden">
                      <div className="overflow-x-auto max-h-56 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 sticky top-0">
                            <tr>
                              <th className="text-left font-medium px-2 py-1.5">Title</th>
                              <th className="text-left font-medium px-2 py-1.5 w-20">Priority</th>
                              <th className="text-left font-medium px-2 py-1.5 w-24">Type</th>
                              <th className="text-left font-medium px-2 py-1.5 w-16">Est.</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.rows.map((r) => (
                              <tr key={r.row} className="border-t border-gray-100 dark:border-gray-800">
                                <td className="px-2 py-1.5 text-gray-900 dark:text-gray-100">
                                  {r.title}
                                  {r.description && (
                                    <span className="block text-[10px] text-gray-400 dark:text-gray-500 truncate max-w-[260px]">
                                      {r.description.split("\n")[0]}
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400">{r.priority}</td>
                                <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400">{r.issueType}</td>
                                <td className="px-2 py-1.5 text-gray-600 dark:text-gray-400">{r.estimate || "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {preview.skipped.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 mb-0.5">Skipped rows</p>
                      <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                        {preview.skipped.map((s) => (
                          <li key={`${s.row}-${s.title}`} className="text-[11px] text-gray-500 dark:text-gray-400">
                            Row {s.row}{s.title ? ` "${s.title}"` : ""}: {s.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {preview.warnings.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 mb-0.5">Warnings</p>
                      <ul className="space-y-0.5 max-h-20 overflow-y-auto">
                        {preview.warnings.map((w, i) => (
                          <li key={i} className="text-[11px] text-amber-600 dark:text-amber-400">
                            Row {w.row} ({w.title}): {w.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {preview.parseErrors.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-red-600 mb-0.5">Parse errors</p>
                      <ul className="space-y-0.5 max-h-20 overflow-y-auto">
                        {preview.parseErrors.map((e, i) => (
                          <li key={i} className="text-[11px] text-red-500">{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between gap-2">
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                {validCount > 0
                  ? `${validCount} issue${validCount === 1 ? "" : "s"} will be created in Backlog.`
                  : "Nothing to import yet."}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => !committing && onClose()}
                  className="px-3 py-1.5 text-xs font-medium rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={validCount === 0 || committing || previewing}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                  {committing && (
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                  )}
                  {committing ? "Creating…" : `Create ${validCount} issue${validCount === 1 ? "" : "s"}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function ImportResultView({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  return (
    <>
      <div className="px-4 py-3 space-y-2 overflow-y-auto flex-1">
        <div className="flex gap-6">
          <div className="text-center">
            <p className="text-2xl font-bold text-emerald-600">{result.created}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Created</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-amber-500">{result.skipped}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Skipped</p>
          </div>
        </div>
        {result.skippedRows.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Skipped rows</p>
            <ul className="space-y-0.5 max-h-32 overflow-y-auto">
              {result.skippedRows.map((sr) => (
                <li key={`${sr.row}-${sr.title}`} className="text-xs text-gray-500 dark:text-gray-400">
                  Row {sr.row}{sr.title ? ` "${sr.title}"` : ""}: {sr.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.parseErrors.length > 0 && (
          <div className="mt-2">
            <p className="text-xs font-semibold text-red-600 mb-1">Parse errors</p>
            <ul className="space-y-0.5 max-h-24 overflow-y-auto">
              {result.parseErrors.map((e, i) => (
                <li key={i} className="text-xs text-red-500">{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors"
        >
          Done
        </button>
      </div>
    </>
  );
}
