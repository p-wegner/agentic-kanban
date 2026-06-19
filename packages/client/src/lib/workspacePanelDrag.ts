/**
 * Pure geometry for the WorkspacePanel's drag-to-reposition / edge-snap
 * behaviour. The panel can be docked as a left/right sidebar or float as a
 * modal; dragging its header detaches it to a modal and dragging back to an
 * edge re-snaps it to a sidebar. The math — where the modal first appears and
 * which snap zone a drag is in — is extracted here so the thresholds are
 * unit-tested instead of buried in mouse-event closures.
 */

/** Distance (px) from a window edge at which a drag commits to snapping. */
export const EDGE_SNAP_THRESHOLD = 80;
/** Slightly wider band where a snap preview overlay is shown before committing. */
export const SNAP_PREVIEW_THRESHOLD = EDGE_SNAP_THRESHOLD + 60;

export type DragSnap = "snap-left" | "snap-right" | "preview-left" | "preview-right" | "none";

/**
 * Where a panel should first appear when a drag detaches it from a sidebar into
 * a floating modal. A left-docked panel jumps to a fixed inset; a right-docked
 * one stays roughly under the cursor (`panelX - 10`), both clamped on-screen.
 */
export function computeModalEntryPosition(
  sidebarSide: "left" | "right",
  panelX: number,
  panelY: number,
  windowWidth: number,
): { x: number; y: number } {
  const modalWidth = Math.min(1200, windowWidth * 0.96);
  const maxX = windowWidth - modalWidth;
  const x =
    sidebarSide === "left"
      ? Math.max(0, Math.min(maxX, 200))
      : Math.max(0, Math.min(maxX, panelX - 10));
  const y = Math.max(0, panelY + 40);
  return { x, y };
}

/**
 * Classify a modal drag by its proximity to the window edges: a commit-snap
 * (within {@link EDGE_SNAP_THRESHOLD}), a preview (within
 * {@link SNAP_PREVIEW_THRESHOLD}), or free movement. Right edge wins ties since
 * it is tested first. `panelWidth` is the panel's current rendered width.
 */
export function classifyDragSnap(newX: number, panelWidth: number, windowWidth: number): DragSnap {
  const right = newX + panelWidth;
  if (right >= windowWidth - EDGE_SNAP_THRESHOLD) return "snap-right";
  if (newX <= EDGE_SNAP_THRESHOLD) return "snap-left";
  if (right >= windowWidth - SNAP_PREVIEW_THRESHOLD) return "preview-right";
  if (newX <= SNAP_PREVIEW_THRESHOLD) return "preview-left";
  return "none";
}
