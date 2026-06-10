import { useEffect, useRef, useState } from "react";
import { ImportIssuesModal } from "./ImportIssuesModal.js";

interface ExportImportMenuProps {
  projectId: string | null;
}

export function ExportImportMenu({ projectId }: ExportImportMenuProps) {
  const [open, setOpen] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
    setShowImportModal(true);
  }

  return (
    <>
      <div className="relative shrink-0" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!projectId}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Export / Import issues"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors bg-surface-raised dark:bg-surface-raised-dark border-black/[0.07] dark:border-white/10 text-ink-soft dark:text-gray-400 hover:bg-surface-sunken dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
          </svg>
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
              Import issues…
            </button>
          </div>
        )}
      </div>

      {showImportModal && projectId && (
        <ImportIssuesModal projectId={projectId} onClose={() => setShowImportModal(false)} />
      )}
    </>
  );
}
