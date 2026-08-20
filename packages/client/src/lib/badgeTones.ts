/**
 * Badge tone tokens.
 *
 * Before this existed, every badge on the board hand-picked its own Tailwind
 * palette inline. That drifted: `blocked`, `estimate` and `overdue` shipped with
 * light-mode classes only, so they burned as bright light chips on the dark
 * board. Tones are the single place a badge's colour is decided.
 *
 * Palette follows the editorial/paper theme (see `app.css`): warm `stone` for
 * neutral rather than the cold `gray`, `brand` (terracotta) and `accent` (sage)
 * for product colour, and semantic hues only where they carry meaning.
 *
 * Invariant, enforced by `badgeTones.test.ts`: every tone declares a `dark:`
 * background *and* a `dark:` text colour.
 */
export type BadgeTone =
  | "neutral"
  | "brand"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

export const badgeToneClasses: Record<BadgeTone, string> = {
  neutral: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300",
  brand: "bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300",
  accent: "bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  success: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  danger: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

/** Solid dot colours for the `dot` affordance — readable on both tone surfaces. */
export const badgeDotClasses: Record<BadgeTone, string> = {
  neutral: "bg-stone-400",
  brand: "bg-brand-500",
  accent: "bg-accent-500",
  info: "bg-sky-500",
  success: "bg-green-500",
  warning: "bg-amber-500",
  danger: "bg-red-500",
};

export function badgeToneClass(tone: BadgeTone = "neutral"): string {
  return badgeToneClasses[tone];
}

export function badgeDotClass(tone: BadgeTone = "neutral"): string {
  return badgeDotClasses[tone];
}

// --- Status → tone (#517) -----------------------------------------------------------
//
// Workspace- and issue-status colours were re-declared as raw Tailwind in ~11 places,
// and the copies drifted in ways only visible in dark mode:
//   * `allWorkspacesStatus.WS_STATUS_COLORS.closed` was
//     `bg-gray-100 text-gray-500 dark:bg-gray-400` — a LIGHT background in dark mode,
//     with no `dark:text-*`, so it rendered grey-on-light-grey. Its sibling in
//     `workspace-helpers.STATUS_COLORS` had the same status right.
//   * several maps were light-only, the exact drift `badgeTones` was introduced to end.
//
// Routing status through a TONE rather than raw classes means each one inherits the
// invariant this module already enforces in badgeTones.test.ts: every tone declares a
// dark background AND a dark text colour. A status can no longer ship half a palette.

/** Workspace lifecycle status → tone. */
export const WORKSPACE_STATUS_TONE: Record<string, BadgeTone> = {
  active: "success",
  reviewing: "accent",
  fixing: "warning",
  idle: "warning",
  "awaiting-plan-approval": "warning",
  blocked: "danger",
  error: "danger",
  closed: "neutral",
};

/** Issue status-column name → tone. Unknown/custom columns fall back to neutral. */
export const ISSUE_STATUS_TONE: Record<string, BadgeTone> = {
  Backlog: "neutral",
  Todo: "neutral",
  "In Progress": "info",
  "In Review": "accent",
  "AI Reviewed": "accent",
  Done: "success",
  Cancelled: "neutral",
};

/** Badge classes for a workspace status, with a neutral fallback for unknown values. */
export function workspaceStatusToneClass(status: string | null | undefined): string {
  return badgeToneClasses[WORKSPACE_STATUS_TONE[status ?? ""] ?? "neutral"];
}

/** Badge classes for an issue status-column name, neutral for custom columns. */
export function issueStatusToneClass(statusName: string | null | undefined): string {
  return badgeToneClasses[ISSUE_STATUS_TONE[statusName ?? ""] ?? "neutral"];
}
