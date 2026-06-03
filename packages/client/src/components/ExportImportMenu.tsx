import { useEffect, useRef, useState } from "react";
import { showToast } from "./Toast.js";

interface ExportImportMenuProps {
  projectId: string | null;
}

interface ImportResult {
  created: number;
  skipped: number;
  skippedRows: { row: number; title: string; reason: string }[];
  parseErrors: string[];
}

export function ExportImportMenu({ projectId }: ExportImportMenuProps) {
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  function handleExport(format: "json" | "csv") {
    if (!projectId) return;
    setOpen(false);
    const anchor = document.createElement("a");
    anchor.href = `/api/projects/${projectId}/issues/export?format=${format}`;
    anchor.download = `issues.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  }

  function handleImportClick() {
    setOpen(false);
    fileInputRef.current?.click();
  }

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !projectId) return;
    event.target.value = "";

    setImporting(true);
    setImportResult(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`/api/projects/${projectId}/issues/import`, {
        method: "POST",
        body: formData,
      });
      const result = (await response.json()) as ImportResult & { error?: string };
      if (!response.ok) {
        showToast(result.error ?? "Import failed", "error");
        return;
      }
      setImportResult(result);
    } catch {
      showToast("Import failed — could not reach server", "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.csv"
        className="hidden"
        onChange={handleFileSelected}
        aria-hidden
      />
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!projectId || importing}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Export / Import issues"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {importing ? (
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
          ) : (
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
            </svg>
          )}
          <span className="hidden sm:inline">Export</span>
        </button>
        {open && (
          <div
            role="menu"
            className="absolute top-full left-0 mt-1 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-30 p-1"
          >
            <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Export
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleExport("json")}
              className="w-full text-left px-2.5 py-1.5 text-xs rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100 flex items-center gap-2"
            >
              <svg className="w-3 h-3 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              Download as JSON
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => handleExport("csv")}
              className="w-full text-left px-2.5 py-1.5 text-xs rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100 flex items-center gap-2"
            >
              <svg className="w-3 h-3 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" />
              </svg>
              Download as CSV
            </button>
            <div className="my-1 border-t border-gray-100 dark:border-gray-800" />
            <p className="px-2.5 pt-0.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Import
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={handleImportClick}
              className="w-full text-left px-2.5 py-1.5 text-xs rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100 flex items-center gap-2"
            >
              <svg className="w-3 h-3 shrink-0 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 8l5-5 5 5M12 3v12" />
              </svg>
              Import from JSON / CSV
            </button>
          </div>
        )}
      </div>

      {importResult && (
        <>
          <div className="fixed inset-0 bg-black/30 z-50" onClick={() => setImportResult(null)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[min(480px,calc(100vw-2rem))] bg-white dark:bg-gray-900 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Import complete</h3>
              <button
                type="button"
                onClick={() => setImportResult(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none"
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <div className="px-4 py-3 space-y-2">
              <div className="flex gap-6">
                <div className="text-center">
                  <p className="text-2xl font-bold text-emerald-600">{importResult.created}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Created</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-amber-500">{importResult.skipped}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">Skipped</p>
                </div>
              </div>
              {importResult.skippedRows.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Skipped rows</p>
                  <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                    {importResult.skippedRows.map((sr) => (
                      <li key={`${sr.row}-${sr.title}`} className="text-xs text-gray-500 dark:text-gray-400">
                        Row {sr.row}{sr.title ? ` "${sr.title}"` : ""}: {sr.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {importResult.parseErrors.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-semibold text-red-600 mb-1">Parse errors</p>
                  <ul className="space-y-0.5 max-h-28 overflow-y-auto">
                    {importResult.parseErrors.map((e, i) => (
                      <li key={i} className="text-xs text-red-500">{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end">
              <button
                type="button"
                onClick={() => setImportResult(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
