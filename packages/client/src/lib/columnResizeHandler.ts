import { useCallback, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

/**
 * Drag-to-resize state for kanban columns, persisted to localStorage.
 * Returns the current width map, the mousedown handler that starts a resize
 * drag (window-level mousemove/mouseup listeners, 160-800px clamp), and a
 * reset handler that removes a column's stored width.
 */
export function useColumnResize() {
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("kanban-column-widths") ?? "{}") as Record<string, number>; } catch { return {}; }
  });
  const resizingRef = useRef<{ colId: string; startX: number; startWidth: number } | null>(null);

  const handleColumnResizeStart = useCallback((colId: string, e: ReactMouseEvent) => {
    e.preventDefault();
    const colEl = document.getElementById(`column-${colId}`);
    const startWidth = colEl ? colEl.getBoundingClientRect().width : (columnWidths[colId] ?? 288);
    resizingRef.current = { colId, startX: e.clientX, startWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      const delta = ev.clientX - resizingRef.current.startX;
      const newWidth = Math.max(160, Math.min(800, resizingRef.current.startWidth + delta));
      setColumnWidths((prev) => ({ ...prev, [resizingRef.current!.colId]: newWidth }));
    };
    const onMouseUp = () => {
      setColumnWidths((prev) => {
        try { localStorage.setItem("kanban-column-widths", JSON.stringify(prev)); } catch {}
        return prev;
      });
      resizingRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [columnWidths]);

  const resetColumnWidth = useCallback((colId: string) => {
    setColumnWidths((prev) => {
      const next = { ...prev };
      delete next[colId];
      try { localStorage.setItem("kanban-column-widths", JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  return { columnWidths, handleColumnResizeStart, resetColumnWidth };
}
