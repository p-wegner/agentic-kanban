import type { ReactNode } from "react";
import { badgeDotClass, badgeToneClass, type BadgeTone } from "../lib/badgeTones.js";

export interface BadgeProps {
  /** Semantic colour. Omit when passing a pre-computed palette via `className`
   *  (e.g. `priorityColors[p]` from `issueCardColorMap`) so the two don't fight. */
  tone?: BadgeTone;
  /** Leading pulsing dot — use for "live"/in-progress states only. */
  dot?: boolean;
  /** Leading icon, typically a 3x3 inline `<svg>`. */
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}

/**
 * The board's badge/chip primitive.
 *
 * Every chip on an issue card is one of these: fixed geometry (pill, `text-xs`,
 * `px-1.5 py-0.5`) so a card's badge row lines up regardless of what's in it,
 * and colour supplied by a `BadgeTone` token rather than ad-hoc Tailwind.
 *
 * Long content truncates rather than wrapping the pill — `min-w-0` on the flex
 * child is what actually lets `truncate` engage inside an `inline-flex`.
 */
export function Badge({ tone, dot, icon, title, className = "", children }: BadgeProps) {
  const toneClasses = tone ? badgeToneClass(tone) : "";
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium ${toneClasses} ${className}`}
      title={title}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${badgeDotClass(tone)} animate-pulse`}
        />
      )}
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
