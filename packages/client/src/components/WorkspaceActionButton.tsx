import React from "react";

/**
 * Shared, on-brand button styling for the workspace action toolbar.
 *
 * Before #840 the action row was a hodgepodge of one-off Tailwind colors
 * (bg-teal-600, bg-sky-600, bg-orange-600, bg-rose-600, bg-gray-700, …) with no
 * shared sizing, focus, or dark-mode rules — which read as "off brand and
 * completely unstyled". This collapses every action into a small set of
 * semantic intents built from the project's brand/accent design tokens so the
 * toolbar is visually coherent and consistent in light and dark mode.
 */
export type ActionIntent =
  | "primary" // brand — the main forward action (Review, View Diff)
  | "accent" // sage — affirmative / completion (Merge, Resume, Approve)
  | "neutral" // low-emphasis utility (Terminal, VS Code, Update Base)
  | "info" // informational / preview (Preview, GitHub Draft)
  | "warn" // attention (Auto-bisect, Export Handoff)
  | "danger" // destructive (Delete, Reject)
  | "ghost"; // bordered, text-only secondary (Close)

const INTENT_CLASSES: Record<ActionIntent, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-700 border-brand-500 focus-visible:ring-brand-500",
  accent:
    "bg-accent-600 text-white hover:bg-accent-700 border-accent-500 focus-visible:ring-accent-500",
  neutral:
    "bg-gray-100 text-gray-700 hover:bg-gray-200 border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 dark:border-gray-600 focus-visible:ring-gray-400",
  info:
    "bg-sky-600 text-white hover:bg-sky-700 border-sky-500 focus-visible:ring-sky-500",
  warn:
    "bg-amber-500 text-white hover:bg-amber-600 border-amber-400 focus-visible:ring-amber-500",
  danger:
    "bg-red-600 text-white hover:bg-red-700 border-red-500 focus-visible:ring-red-500",
  ghost:
    "bg-transparent text-gray-600 hover:bg-gray-100 border-gray-300 dark:text-gray-300 dark:hover:bg-gray-800 dark:border-gray-600 focus-visible:ring-gray-400",
};

const BASE =
  "inline-flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-gray-900";

interface WorkspaceActionButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: ActionIntent;
  /** Override border radius when used inside a segmented group. */
  rounded?: string;
}

/** A single, consistently styled action button for the workspace toolbar. */
export function WorkspaceActionButton({
  intent = "neutral",
  rounded,
  className = "",
  children,
  ...rest
}: WorkspaceActionButtonProps) {
  const radius = rounded ?? "rounded-md";
  const base = rounded ? BASE.replace("rounded-md", "") : BASE;
  return (
    <button
      {...rest}
      className={`${base} ${radius} ${INTENT_CLASSES[intent]} ${className}`}
    >
      {children}
    </button>
  );
}
