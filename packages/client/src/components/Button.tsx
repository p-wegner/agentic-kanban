import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  buttonSizeClass,
  buttonVariantClass,
  iconButtonSizeClass,
  type ButtonSize,
  type ButtonVariant,
} from "../lib/buttonVariants.js";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Semantic style. Defaults to `primary` (the terracotta call-to-action). */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square padding for a single-icon button (toolbar / close affordances). */
  iconOnly?: boolean;
  /** Leading icon, typically a 3.5x3.5 inline `<svg>`. */
  icon?: ReactNode;
  children?: ReactNode;
}

/**
 * The board's button primitive.
 *
 * Fixed geometry (pill-ish `rounded-md`, `inline-flex` centred content,
 * `transition-colors`, consistent disabled + focus-visible affordances) baked in
 * so a footer's buttons line up regardless of caller; colour supplied only by a
 * `ButtonVariant` token rather than ad-hoc Tailwind. The `className` escape hatch
 * is appended last, so a caller can still tweak layout without forking the palette.
 *
 * Defaults to `type="button"` so a button dropped into a `<form>` never submits
 * by accident — pass `type="submit"` explicitly when that is the intent.
 */
const base =
  "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1";

export function Button({
  variant = "primary",
  size = "md",
  iconOnly = false,
  icon,
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const sizeClasses = iconOnly ? iconButtonSizeClass(size) : buttonSizeClass(size);
  return (
    <button
      type={type}
      className={`${base} ${buttonVariantClass(variant)} ${sizeClasses} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
