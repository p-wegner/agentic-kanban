/**
 * Non-view keyboard shortcut registry (#388).
 *
 * This is the single source of truth for every non-view shortcut wired in
 * BoardPage's keydown handler. The `?` overlay in ShortcutHelp derives its
 * list from here — add or remove entries here whenever the actual handler
 * changes so the overlay never drifts.
 *
 * View-switching shortcuts (b, r, g, l, m, …) are NOT listed here; they are
 * sourced from the canonical VIEW_REGISTRY in viewRegistry.tsx.
 */

export type ShortcutCategory = "Navigation" | "Board" | "Panels";

export interface ShortcutEntry {
  keys: string[];
  description: string;
  category: ShortcutCategory;
  /** True when keys must be pressed in sequence rather than simultaneously. */
  sequential?: boolean;
}

export const SHORTCUT_REGISTRY: ShortcutEntry[] = [
  // Navigation
  { keys: ["/"], description: "Focus search", category: "Navigation" },
  { keys: ["Ctrl", "K"], description: "Command palette", category: "Navigation" },
  { keys: ["Escape"], description: "Close panel / clear search / go back", category: "Navigation" },
  { keys: ["?"], description: "Show keyboard shortcuts", category: "Navigation" },
  // Board
  { keys: ["↑", "↓"], description: "Move selection up / down within column", category: "Board" },
  { keys: ["←", "→"], description: "Move selection left / right across columns", category: "Board" },
  { keys: ["Enter"], description: "Open selected card's detail panel", category: "Board" },
  { keys: ["w"], description: "New issue + start workspace", category: "Board" },
  { keys: ["Shift", "V"], description: "Start voice inbox (record idea → Backlog issue)", category: "Board" },
  { keys: ["g", "s"], description: "Open settings", category: "Board", sequential: true },
  // Panels
  { keys: ["a"], description: "Toggle All Workspaces panel", category: "Panels" },
  { keys: ["q"], description: "Open Quick Tasks panel", category: "Panels" },
  { keys: ["x"], description: "Open Codemod Factory", category: "Panels" },
];
