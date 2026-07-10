/**
 * Button variant tokens.
 *
 * Sibling to `badgeTones.ts`. Before this existed, every button on the board
 * hand-picked its own Tailwind palette + geometry inline. The primary terracotta
 * action (`bg-brand-600 … hover:bg-brand-700`) alone recurred across ~47 files,
 * each re-deciding radius (`rounded` / `-md` / `-lg`), size (`text-xs` / `-sm`,
 * `py-1` / `py-1.5`), disabled opacity (`40` / `50`) and whether it bothered with
 * `transition-colors`. Secondary/ghost buttons drifted worse, hand-rolling cold
 * `gray-*` neutrals instead of the warm editorial `surface`/`ink`/`stone` palette
 * the theme (see `app.css`) was built for. Variants are the single place a
 * button's colour is decided; the `Button` primitive owns the geometry.
 *
 * Invariant, enforced by `buttonVariants.test.ts`: every variant declares a
 * dark-mode hover state, every variant carrying a non-white text colour declares
 * a `dark:` text colour, and every variant declares a focus-visible ring — so a
 * new variant can't regress into a light-only chip that glares on the dark board
 * (the exact bug class `badgeTones` was created to close).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export const buttonVariantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-600 dark:hover:bg-brand-500 focus-visible:ring-brand-500",
  secondary:
    "border border-stone-200 bg-surface-raised text-ink-soft hover:bg-surface-sunken " +
    "dark:border-stone-700 dark:bg-surface-raised-dark dark:text-stone-300 dark:hover:bg-surface-sunken-dark " +
    "focus-visible:ring-brand-500",
  ghost:
    "text-ink-soft hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800 focus-visible:ring-brand-500",
  danger:
    "bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-500 focus-visible:ring-red-500",
};

/** Padding + text size for a normal (text) button. */
export const buttonSizeClasses: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs",
  md: "px-3 py-1.5 text-sm",
};

/** Square padding for a single-icon button (toolbar / close affordances). */
export const iconButtonSizeClasses: Record<ButtonSize, string> = {
  sm: "p-1",
  md: "p-1.5",
};

export function buttonVariantClass(variant: ButtonVariant = "primary"): string {
  return buttonVariantClasses[variant];
}

export function buttonSizeClass(size: ButtonSize = "md"): string {
  return buttonSizeClasses[size];
}

export function iconButtonSizeClass(size: ButtonSize = "md"): string {
  return iconButtonSizeClasses[size];
}
