import { useCallback, useEffect, useRef, useState } from "react";

// Shared persisted layout for the detail panels (issue + workspace).
//
// The old "side drawer" was a fixed narrow width (384px / 560px) that wasted
// screen space on wide monitors and was awkward to read/edit in. This hook gives
// each panel a *resizable* sidebar whose width persists across sessions, plus a
// persisted preferred display mode so the user's choice (drawer vs. modal vs.
// fullscreen) sticks instead of resetting to the cramped drawer every time.

export type PanelMode = "sidebar" | "modal" | "fullscreen";

interface PanelLayoutConfig {
  /** localStorage key prefix, unique per panel (e.g. "issueDetail", "workspace"). */
  storageKey: string;
  /** Display modes this panel supports, in cycle order. */
  modes: PanelMode[];
  /** Default sidebar width (px) when nothing is stored. */
  defaultWidth: number;
  /** Clamp bounds for the sidebar width. */
  minWidth: number;
  maxWidth: number;
}

interface StoredLayout {
  mode?: PanelMode;
  width?: number;
}

function readStored(storageKey: string): StoredLayout {
  try {
    const raw = localStorage.getItem(`panelLayout:${storageKey}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredLayout;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStored(storageKey: string, layout: StoredLayout) {
  try {
    localStorage.setItem(`panelLayout:${storageKey}`, JSON.stringify(layout));
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function usePanelLayout(config: PanelLayoutConfig) {
  const { storageKey, modes, defaultWidth, minWidth, maxWidth } = config;

  const clampWidth = useCallback(
    (w: number) => Math.max(minWidth, Math.min(maxWidth, Math.round(w))),
    [minWidth, maxWidth],
  );

  const [mode, setModeState] = useState<PanelMode>(() => {
    const stored = readStored(storageKey).mode;
    return stored && modes.includes(stored) ? stored : modes[0];
  });
  const [sidebarWidth, setSidebarWidthState] = useState<number>(() => {
    const stored = readStored(storageKey).width;
    return typeof stored === "number" ? clampWidth(stored) : clampWidth(defaultWidth);
  });
  const [resizing, setResizing] = useState(false);

  const persist = useCallback(
    (next: StoredLayout) => {
      writeStored(storageKey, { mode, width: sidebarWidth, ...next });
    },
    [storageKey, mode, sidebarWidth],
  );

  const setMode = useCallback(
    (next: PanelMode) => {
      setModeState(next);
      persist({ mode: next });
    },
    [persist],
  );

  /** Cycle to the next supported mode (used by the expand button). */
  const cycleMode = useCallback(() => {
    setModeState((m) => {
      const idx = modes.indexOf(m);
      const next = modes[(idx + 1) % modes.length];
      persist({ mode: next });
      return next;
    });
  }, [modes, persist]);

  const setSidebarWidth = useCallback(
    (w: number) => {
      const clamped = clampWidth(w);
      setSidebarWidthState(clamped);
      persist({ width: clamped });
    },
    [clampWidth, persist],
  );

  // Drag-to-resize the sidebar from its inner edge. `side` tells us which way the
  // panel is anchored so the width grows in the correct direction.
  const startResize = useCallback(
    (e: React.MouseEvent, side: "left" | "right") => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      setResizing(true);

      const onMove = (ev: MouseEvent) => {
        // Right-anchored: dragging the left edge leftwards widens it.
        const delta = side === "right" ? startX - ev.clientX : ev.clientX - startX;
        const clamped = clampWidth(startWidth + delta);
        setSidebarWidthState(clamped);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setResizing(false);
        // Persist the final width once (avoids thrashing localStorage on every move).
        setSidebarWidthState((w) => {
          persist({ width: w });
          return w;
        });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, clampWidth, persist],
  );

  // Keep within bounds if the viewport shrinks below the stored width.
  useEffect(() => {
    const onResize = () => {
      setSidebarWidthState((w) => {
        const clamped = clampWidth(w);
        return clamped === w ? w : clamped;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clampWidth]);

  return { mode, setMode, cycleMode, sidebarWidth, setSidebarWidth, startResize, resizing };
}
