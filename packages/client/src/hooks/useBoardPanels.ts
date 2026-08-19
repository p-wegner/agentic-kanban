import type { Dispatch, SetStateAction } from "react";
import { useCallback, useMemo, useState } from "react";
import type { IssueWithStatus } from "@agentic-kanban/shared";
import {
  PANEL_CLOSE_ORDER,
  PANEL_IDS,
  type PanelCloseProp,
  type PanelId,
  type PanelShowProp,
} from "../lib/panelRegistry.js";

/**
 * Overlay-panel open/close state, driven by `lib/panelRegistry.ts` (#588).
 *
 * This hook used to hold NINETEEN `useState<boolean>` pairs and hand-list every
 * `showX` / `setShowX` / `onCloseX` three times over — 141 per-panel declarations, and a new
 * panel meant editing four files. The state is now one `Set<PanelId>` and every surface below
 * is DERIVED from the registry, so adding a panel is one entry in `PANEL_IDS`.
 *
 * The public shape is deliberately unchanged: `showX`, `setShowX` and `overlayPanelProps`
 * are the same names with the same types, expressed as mapped types instead of by hand, so
 * `BoardPageView`, `BoardOverlayPanels` and `useBoardKeyboardShortcuts` are untouched. That
 * is what keeps a 19-panel refactor reviewable — the consumers cannot tell.
 */

/** `{ showSettings: boolean, showQuickTasks: boolean, … }` — one per registered panel. */
type PanelShowFlags = { [K in PanelId as PanelShowProp<K>]: boolean };
/** `{ onCloseSettings: () => void, … }` */
type PanelCloseHandlers = { [K in PanelId as PanelCloseProp<K>]: () => void };
/** `{ setShowSettings: Dispatch<SetStateAction<boolean>>, … }` */
type PanelSetters = { [K in PanelId as `set${Capitalize<PanelShowProp<K>>}`]: Dispatch<SetStateAction<boolean>> };

export type BoardOverlayPanelProps = PanelShowFlags & PanelCloseHandlers & {
  dryRunIssue: IssueWithStatus | null;
  setDryRunIssue: (issue: IssueWithStatus | null) => void;
};

export type BoardPanelState = PanelShowFlags & PanelSetters & {
  dryRunIssue: IssueWithStatus | null;
  setDryRunIssue: (issue: IssueWithStatus | null) => void;
  openStartWorkspacePicker: () => void;
  closeStartWorkspacePicker: () => void;
  /** Close the topmost open panel; `false` when none was open (so Escape can fall through). */
  closeTopPanel: () => boolean;
  overlayPanelProps: BoardOverlayPanelProps;
};

const capitalize = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function useBoardPanels(): BoardPanelState {
  const [open, setOpen] = useState<ReadonlySet<PanelId>>(() => new Set());
  const [dryRunIssue, setDryRunIssue] = useState<IssueWithStatus | null>(null);

  /**
   * One setter per panel, memoised as a group. `SetStateAction` is honoured (callers pass
   * `(v) => !v` to toggle), which the hand-written `useState` setters did for free and a
   * naive `(v: boolean) => …` replacement would have silently broken.
   */
  const setters = useMemo(() => {
    const out = {} as Record<string, Dispatch<SetStateAction<boolean>>>;
    for (const id of PANEL_IDS) {
      out[`setShow${capitalize(id)}`] = (action) => {
        setOpen((prev) => {
          const wasOpen = prev.has(id);
          const next = typeof action === "function" ? action(wasOpen) : action;
          if (next === wasOpen) return prev;
          const copy = new Set(prev);
          if (next) copy.add(id);
          else copy.delete(id);
          return copy;
        });
      };
    }
    return out as PanelSetters;
  }, []);

  const flags = useMemo(() => {
    const out = {} as Record<string, boolean>;
    for (const id of PANEL_IDS) out[`show${capitalize(id)}`] = open.has(id);
    return out as PanelShowFlags;
  }, [open]);

  const closeHandlers = useMemo(() => {
    const out = {} as Record<string, () => void>;
    for (const id of PANEL_IDS) {
      out[`onClose${capitalize(id)}`] = () => setOpen((prev) => {
        if (!prev.has(id)) return prev;
        const copy = new Set(prev);
        copy.delete(id);
        return copy;
      });
    }
    return out as PanelCloseHandlers;
  }, []);

  const closeTopPanel = useCallback(() => {
    // The order lives in the registry now; it used to be the sequence of an if-chain, where
    // "which panel is topmost" could not be read without tracing every branch.
    const top = PANEL_CLOSE_ORDER.find((id) => open.has(id));
    if (!top) return false;
    setOpen((prev) => {
      const copy = new Set(prev);
      copy.delete(top);
      return copy;
    });
    return true;
  }, [open]);

  const openStartWorkspacePicker = useCallback(
    () => setOpen((prev) => new Set(prev).add("startWorkspacePicker")),
    [],
  );
  const closeStartWorkspacePicker = useCallback(() => setOpen((prev) => {
    const copy = new Set(prev);
    copy.delete("startWorkspacePicker");
    return copy;
  }), []);

  const overlayPanelProps = useMemo<BoardOverlayPanelProps>(
    () => ({ ...flags, ...closeHandlers, dryRunIssue, setDryRunIssue }),
    [flags, closeHandlers, dryRunIssue],
  );

  return {
    ...flags,
    ...setters,
    dryRunIssue,
    setDryRunIssue,
    openStartWorkspacePicker,
    closeStartWorkspacePicker,
    closeTopPanel,
    overlayPanelProps,
  };
}
