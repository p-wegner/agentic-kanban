import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: ReactNode;
  /** Muted status line shown next to the title (e.g. current filter/sort, WIP). */
  summary?: ReactNode;
  /** Small badge (count) shown after the title. */
  badge?: ReactNode;
  /** Controls that stay in the header and don't toggle the panel (e.g. Refresh). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
  /** Body wrapper className override (defaults to padded). */
  bodyClassName?: string;
  /** Surface tint. "brand" for contextual/action panels (e.g. selection). */
  tone?: "default" | "brand";
}

/**
 * Lightweight expansion panel: a header row (chevron + title + summary + badge,
 * with optional non-toggling actions on the right) over a collapsible body.
 * Used to keep the Backlog's secondary controls tucked away so the issue list
 * gets the vertical space, especially on small screens.
 */
export function CollapsibleSection({
  title,
  summary,
  badge,
  actions,
  defaultOpen = false,
  children,
  className = "",
  bodyClassName = "border-t border-gray-100 px-3 py-2 dark:border-gray-800",
  tone = "default",
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toneClass = tone === "brand"
    ? "border-brand-200 bg-brand-50 dark:border-brand-800 dark:bg-brand-900/30"
    : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900";

  return (
    <div className={`rounded-md border ${toneClass} ${className}`}>
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={open ? "Collapse" : "Expand"}
        >
          <svg
            className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
          </svg>
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {title}
          </span>
          {badge}
          {summary != null && (
            <span className="min-w-0 truncate text-xs text-gray-400 dark:text-gray-500">{summary}</span>
          )}
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {open && <div className={bodyClassName}>{children}</div>}
    </div>
  );
}
