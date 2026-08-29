import { useEffect } from "react";
import type { TicketTrailControls } from "../lib/ticketTrailCore.js";

/**
 * Window-level keyboard handling for the issue detail panel: Escape closes (or
 * cancels an in-progress edit), and Alt+Left/Right walks the multi-ticket trail
 * (#383) the way browser back/forward does.
 *
 * Its own hook because `IssueDetailPanel` sits against the client function-nloc
 * ratchet (#763) and this block is entirely self-contained — it reads no panel
 * state beyond the four values passed in, and the file already delegates its other
 * cross-cutting concerns to hooks (`useModalDrag`, `useIssueActions`,
 * `useIssueInlineEdit`).
 */
export function useIssueDetailKeyboard(opts: {
  editing: boolean;
  onCancelEdit: () => void;
  onClose: () => void;
  trail?: TicketTrailControls;
}): void {
  const { editing, onCancelEdit, onClose, trail } = opts;
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (editing) {
          onCancelEdit();
        } else {
          onClose();
        }
        return;
      }
      // Browser-like back/forward across the multi-ticket trail (#383). Skip
      // while editing so it can't yank you off a half-written description.
      if (!editing && trail && e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (e.key === "ArrowLeft") trail.onBack();
        else trail.onForward();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editing, onCancelEdit, onClose, trail]);
}
