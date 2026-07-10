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
