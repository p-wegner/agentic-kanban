import type { ReactNode } from "react";
import { Icon } from "./Icon.js";

/**
 * The page shell every windowed dashboard chart sat inside (#732).
 *
 * Four charts each spelled out the same scroll container, the same max-width column, the
 * same heading + subtitle pair, the same window-selector button row (with its own copy of
 * the selected/unselected class strings), the same centred loading row, the same
 * error-plus-Retry block, and the same dashed empty-state card. Only the strings and the
 * window union differed. That is the bulk of the 72–78 % duplication clone detection
 * measured between `ProviderMixChart` and `ProviderCostOverTimeChart`.
 *
 * The frame owns the four-way state decision — loading, error, empty, ready — so a chart
 * can no longer render its content and its empty state under subtly different conditions
 * (two of the four had already drifted on exactly that).
 */

/** Chart content is a THUNK, not a node: it is only evaluated in the ready state, so a
 *  caller may dereference its non-null data inside without a redundant guard. */
export interface ChartFrameProps<W extends number> {
  title: string;
  subtitle: string;
  /** Selectable windows, in days — rendered as the `Nd` button row. */
  windows: readonly W[];
  days: W;
  onDaysChange: (days: W) => void;
  loading: boolean;
  /** Shown while loading, e.g. "Loading cost data...". */
  loadingLabel: string;
  error: string | null;
  onRetry: () => void;
  /** True when the fetch succeeded but there is nothing to plot. */
  empty: boolean;
  /** The dashed card shown when `empty` — icon path + sentence. */
  emptyIconPath: string;
  emptyLabel: string;
  /** Tailwind max-width for the content column. */
  maxWidth?: string;
  children: () => ReactNode;
}

export function ChartFrame<W extends number>({
  title,
  subtitle,
  windows,
  days,
  onDaysChange,
  loading,
  loadingLabel,
  error,
  onRetry,
  empty,
  emptyIconPath,
  emptyLabel,
  maxWidth = "max-w-4xl",
  children,
}: ChartFrameProps<W>) {
  return (
    <div className="flex-1 overflow-auto px-4 pb-6">
      <div className={`mx-auto ${maxWidth} space-y-5 pt-3`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
          </div>
          <div className="flex gap-1">
            {windows.map((w) => (
              <button
                key={w}
                onClick={() => onDaysChange(w)}
                className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                  days === w
                    ? "bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900"
                    : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>

        {loading && (
          <div className="flex h-64 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
            {loadingLabel}
          </div>
        )}

        {!loading && error && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-red-600 dark:text-red-400">
            <span>{error}</span>
            <button
              onClick={onRetry}
              className="rounded bg-red-100 px-3 py-1 text-xs text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && empty && (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-200 text-sm text-gray-400 dark:border-gray-700 dark:text-gray-500">
            <Icon className="w-10 h-10" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d={emptyIconPath} />
            </Icon>
            <span>{emptyLabel}</span>
          </div>
        )}

        {!loading && !error && !empty && children()}
      </div>
    </div>
  );
}

/** One summary tile above a chart: uppercase label, big value, small hint. */
export function ChartStatTile({
  label,
  value,
  hint,
  swatch,
}: {
  label: string;
  value: ReactNode;
  hint: ReactNode;
  /** Optional colour chip rendered before the label, matching a series. */
  swatch?: string;
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
        {swatch && <span className="h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: swatch }} />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</div>
    </div>
  );
}

/** Equal-width tile row. `columns` is capped by the caller, not here. */
export function ChartStatTiles({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {children}
    </div>
  );
}

/** The bordered card an SVG chart and its legend sit in. */
export function ChartCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      {children}
    </div>
  );
}
