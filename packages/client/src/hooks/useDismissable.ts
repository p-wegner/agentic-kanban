// One outside-click + Escape dismiss effect (#515).
//
// ~16 components hand-rolled this: an effect guarded on `open`, a `mousedown` listener
// testing `ref.current.contains(e.target)`, sometimes a `keydown` listener for Escape,
// then symmetric removal.
//
// They drifted in a way the user can feel: BoardFilterMenu closes on Escape,
// BadgeEditors does not (two copies in that one file, neither handling it). So whether a
// dropdown is dismissable by keyboard depends on which dropdown you opened — and the
// ones that ignore Escape are a genuine accessibility gap, not just an inconsistency.
//
// The decision logic is a plain function so it is testable without a DOM renderer (this
// package has no @testing-library/react — cf. ButlerQuestionCard.test.tsx).

import { useEffect, type RefObject } from "react";

export interface DismissDecisionInput {
  /** Is the popover currently open? A closed popover ignores everything. */
  open: boolean;
  /** Did the pointer event land inside the popover's own subtree? */
  insideContainer: boolean;
}

/** Whether an outside pointer-down should dismiss. */
export function shouldDismissOnPointerDown({ open, insideContainer }: DismissDecisionInput): boolean {
  return open && !insideContainer;
}

/**
 * Whether a key event should dismiss. Only a bare Escape — a modified Escape belongs to
 * the browser/OS, and swallowing it would break e.g. an IME composition cancel.
 */
export function shouldDismissOnKey(
  open: boolean,
  key: string,
  modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): boolean {
  if (!open || key !== "Escape") return false;
  return !modifiers.altKey && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey;
}

/**
 * Close `open` when the user clicks outside `ref` or presses Escape.
 *
 * Uses `mousedown` rather than `click` deliberately, matching what every copy did: a
 * `click` listener fires after the target has already acted, so a dropdown item that
 * re-renders the tree can swallow its own dismissal.
 */
export interface DismissableOptions {
  /**
   * Runs INSTEAD of `onClose` on Escape. Only for a popover whose keyboard dismissal
   * legitimately does more than close — e.g. a context menu that must hand focus back
   * to the card it opened from, which an outside CLICK must not do (the click has
   * already moved focus somewhere the user chose).
   */
  onEscape?: () => void;
}

export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  options: DismissableOptions = {},
): void {
  const { onEscape } = options;
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent) => {
      const insideContainer = !!ref.current && ref.current.contains(e.target as Node);
      if (shouldDismissOnPointerDown({ open: true, insideContainer })) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldDismissOnKey(true, e.key, e)) (onEscape ?? onClose)();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, open, onClose, onEscape]);
}
