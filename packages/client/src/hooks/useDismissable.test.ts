import { describe, it, expect } from "vitest";
import { shouldDismissOnPointerDown, shouldDismissOnKey } from "./useDismissable.js";

describe("shouldDismissOnPointerDown (#515)", () => {
  it("dismisses on a click outside", () => {
    expect(shouldDismissOnPointerDown({ open: true, insideContainer: false })).toBe(true);
  });

  it("keeps the popover open for a click inside", () => {
    expect(shouldDismissOnPointerDown({ open: true, insideContainer: false })).toBe(true);
    expect(shouldDismissOnPointerDown({ open: true, insideContainer: true })).toBe(false);
  });

  it("does nothing while closed", () => {
    expect(shouldDismissOnPointerDown({ open: false, insideContainer: false })).toBe(false);
  });
});

describe("shouldDismissOnKey (#515)", () => {
  it("dismisses on a bare Escape — the behaviour several copies were MISSING", () => {
    // BadgeEditors (x2) and others registered only a mousedown listener, so their
    // dropdowns could not be dismissed from the keyboard at all.
    expect(shouldDismissOnKey(true, "Escape")).toBe(true);
  });

  it("ignores other keys", () => {
    expect(shouldDismissOnKey(true, "Enter")).toBe(false);
    expect(shouldDismissOnKey(true, "e")).toBe(false);
    expect(shouldDismissOnKey(true, "Esc")).toBe(false); // legacy IE spelling, not emitted
  });

  it("ignores a MODIFIED Escape", () => {
    // A modified Escape belongs to the browser/OS (e.g. IME composition cancel);
    // swallowing it here would break those.
    expect(shouldDismissOnKey(true, "Escape", { shiftKey: true })).toBe(false);
    expect(shouldDismissOnKey(true, "Escape", { ctrlKey: true })).toBe(false);
    expect(shouldDismissOnKey(true, "Escape", { metaKey: true })).toBe(false);
    expect(shouldDismissOnKey(true, "Escape", { altKey: true })).toBe(false);
  });

  it("does nothing while closed", () => {
    expect(shouldDismissOnKey(false, "Escape")).toBe(false);
  });
});
