import React, { useRef, useState } from "react";
import type { PanelMode } from "./usePanelLayout.js";

// Drag-to-move behavior for the detail panel header: dragging a sidebar panel
// pops it out into a draggable modal; dragging the modal to a screen edge snaps
// it back into a (left/right) sidebar, with a snap-zone preview while
// approaching the edge.

interface UseModalDragOptions {
  panelMode: PanelMode;
  setPanelMode: (mode: PanelMode) => void;
  setSidebarSide: (side: "left" | "right") => void;
}

export function useModalDrag({ panelMode, setPanelMode, setSidebarSide }: UseModalDragOptions) {
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [snapZone, setSnapZone] = useState<"left" | "right" | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panelX: number; panelY: number } | null>(null);
  const wasDraggingRef = useRef(false);

  function handleHeaderMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const panel = (e.currentTarget as HTMLElement).closest("[data-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: rect.left, panelY: rect.top };

    // Snap thresholds based on mouse position (not panel edge)
    const EDGE_SNAP_THRESHOLD = 100; // px from screen edge where mouse triggers snap
    // Track current drag mode via ref to avoid stale closure issues
    let currentDragMode: "sidebar" | "modal" | "fullscreen" = panelMode;
    let cleanup: (() => void) | null = null;

    // If starting drag from sidebar, immediately switch to modal mode
    if (currentDragMode === "sidebar") {
      const modalWidth = Math.min(1200, window.innerWidth * 0.96);
      // Position modal so the grab offset relative to panel left is preserved
      const grabOffsetX = e.clientX - rect.left;
      const idealModalX = e.clientX - Math.min(grabOffsetX, modalWidth - 80);
      const modalX = Math.max(0, Math.min(window.innerWidth - modalWidth, idealModalX));
      const modalY = Math.max(0, window.innerHeight * 0.05);
      currentDragMode = "modal";
      setPanelMode("modal");
      setDragPos({ x: modalX, y: modalY });
      // Reset drag origin to current mouse + modal position so subsequent moves are relative to now
      dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: modalX, panelY: modalY };
    }

    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.mouseX;
      const dy = ev.clientY - dragStartRef.current.mouseY;
      const newX = dragStartRef.current.panelX + dx;
      const newY = dragStartRef.current.panelY + dy;
      if (currentDragMode === "modal") {
        // Snap based on mouse position relative to screen edges
        const mouseNearRightEdge = ev.clientX >= window.innerWidth - EDGE_SNAP_THRESHOLD;
        const mouseNearLeftEdge = ev.clientX <= EDGE_SNAP_THRESHOLD;
        if (mouseNearRightEdge) {
          currentDragMode = "sidebar";
          setPanelMode("sidebar");
          setSidebarSide("right");
          setSnapZone(null);
          setDragPos(null);
          dragStartRef.current = null;
          cleanup?.();
          return;
        }
        if (mouseNearLeftEdge) {
          currentDragMode = "sidebar";
          setPanelMode("sidebar");
          setSidebarSide("left");
          setSnapZone(null);
          setDragPos(null);
          dragStartRef.current = null;
          cleanup?.();
          return;
        }
        // Show snap zone preview when mouse approaches edges
        const SNAP_PREVIEW_THRESHOLD = EDGE_SNAP_THRESHOLD + 80;
        const approachingRight = ev.clientX >= window.innerWidth - SNAP_PREVIEW_THRESHOLD;
        const approachingLeft = ev.clientX <= SNAP_PREVIEW_THRESHOLD;
        setSnapZone(approachingRight ? "right" : approachingLeft ? "left" : null);
        setDragPos({ x: newX, y: newY });
      }
    };
    const onUp = () => {
      dragStartRef.current = null;
      wasDraggingRef.current = true;
      setSnapZone(null);
      cleanup?.();
      // Reset drag flag after current event cycle so backdrop onClick is suppressed
      setTimeout(() => { wasDraggingRef.current = false; }, 0);
    };
    cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return { dragPos, setDragPos, snapZone, wasDraggingRef, handleHeaderMouseDown };
}
