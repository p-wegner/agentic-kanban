import { useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { classifyDragSnap, computeModalEntryPosition } from "../lib/workspacePanelDrag.js";
import type { PanelMode } from "./usePanelLayout.js";

export interface UseWorkspacePanelDragParams {
  panelMode: PanelMode;
  setPanelMode: (mode: PanelMode) => void;
}

export interface UseWorkspacePanelDragResult {
  /** Which side the panel docks to when in sidebar mode. */
  sidebarSide: "left" | "right";
  /** Absolute position while floating as a modal, or `null` when docked. */
  dragPos: { x: number; y: number } | null;
  /** Lets the host clear the floating position (e.g. the snap-back toolbar button). */
  setDragPos: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  /** Active edge-snap preview overlay, or `null`. */
  snapZone: "left" | "right" | null;
  /** Bind to the panel header's `onMouseDown` to start a drag. */
  handleHeaderMouseDown: (e: ReactMouseEvent) => void;
}

/**
 * The WorkspacePanel's drag-to-reposition / edge-snap interaction, lifted out
 * of the component. Owns the sidebar side, floating position, and snap-preview
 * state; drives the global mouse-move/up listeners for a drag; and delegates
 * all geometry to the pure, tested helpers in `lib/workspacePanelDrag`.
 *
 * Panel mode (sidebar vs modal) is owned by `usePanelLayout` upstream and
 * threaded in, since detaching/re-snapping flips it.
 */
export function useWorkspacePanelDrag({
  panelMode,
  setPanelMode,
}: UseWorkspacePanelDragParams): UseWorkspacePanelDragResult {
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("right");
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [snapZone, setSnapZone] = useState<"left" | "right" | null>(null);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panelX: number; panelY: number } | null>(null);

  function handleHeaderMouseDown(e: ReactMouseEvent) {
    if ((e.target as HTMLElement).closest("button")) return;
    const panel = (e.currentTarget as HTMLElement).closest("[data-panel]") as HTMLElement;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panelX: rect.left, panelY: rect.top };

    let currentDragMode: PanelMode = panelMode === "modal" ? "modal" : "sidebar";
    let cleanup: (() => void) | null = null;

    // A drag always operates in modal mode: detach from the sidebar first.
    if (currentDragMode === "sidebar") {
      const entry = computeModalEntryPosition(sidebarSide, dragStartRef.current.panelX, dragStartRef.current.panelY, window.innerWidth);
      currentDragMode = "modal";
      setPanelMode("modal");
      setDragPos(entry);
      dragStartRef.current = { ...dragStartRef.current, panelX: entry.x, panelY: entry.y };
    }

    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragStartRef.current) return;
      const dx = ev.clientX - dragStartRef.current.mouseX;
      const dy = ev.clientY - dragStartRef.current.mouseY;
      const newX = dragStartRef.current.panelX + dx;
      const newY = dragStartRef.current.panelY + dy;
      if (currentDragMode !== "modal") return;
      const snap = classifyDragSnap(newX, panel.getBoundingClientRect().width, window.innerWidth);
      if (snap === "snap-right" || snap === "snap-left") {
        currentDragMode = "sidebar";
        setPanelMode("sidebar");
        setSidebarSide(snap === "snap-right" ? "right" : "left");
        setSnapZone(null);
        setDragPos(null);
        dragStartRef.current = null;
        cleanup?.();
        return;
      }
      setSnapZone(snap === "preview-right" ? "right" : snap === "preview-left" ? "left" : null);
      setDragPos({ x: newX, y: newY });
    };
    const onUp = () => {
      dragStartRef.current = null;
      setSnapZone(null);
      cleanup?.();
    };
    cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return { sidebarSide, dragPos, setDragPos, snapZone, handleHeaderMouseDown };
}
