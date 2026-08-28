import { describeAutoStartSkipReason } from "../lib/autoStartSkipReason.js";

interface IssueAutoStartSkipBadgeProps {
  /** `issues.last_auto_start_skip_reason` (#919); absent = the monitor has not declined this ticket. */
  reason?: string | null;
  /** ISO timestamp of that decision, shown so a stale hold is recognisable as stale. */
  at?: string | null;
}

/**
 * #919 — "why is #57 not running", answered in the issue panel.
 *
 * Renders nothing when the monitor has never declined this ticket (or has since started it, which
 * clears the record) — the common case, so the panel does not grow a permanent empty row.
 */
export function IssueAutoStartSkipBadge({ reason, at }: IssueAutoStartSkipBadgeProps) {
  const display = describeAutoStartSkipReason(reason);
  if (!display) return null;

  const when = at ? new Date(at) : null;
  const whenLabel = when && !Number.isNaN(when.getTime()) ? when.toLocaleString("en-US") : null;

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Not Auto-Started
        </label>
        <span
          title={display.detail}
          className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded ${
            display.kind === "hold"
              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          }`}
        >
          {display.label}
        </span>
        {whenLabel && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500">{whenLabel}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{display.detail}</p>
    </div>
  );
}
