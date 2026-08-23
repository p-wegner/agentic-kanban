import type { ViewTabDescriptor } from "../lib/viewTabs.js";
import { withViewTabGroupHeaders } from "../lib/viewTabGroups.js";

interface ViewTabBarProps<T extends string> {
  tabs: readonly ViewTabDescriptor[];
  active: T;
  onSelect: (id: T) => void;
}

/**
 * Shared tab strip for the tabbed container views (#234 Analytics, #235 event
 * feeds). Renders optional group headers ("Flow", "Agents") before the first
 * tab of each group.
 */
export function ViewTabBar<T extends string>({ tabs, active, onSelect }: ViewTabBarProps<T>) {
  return (
    <div
      className="flex items-center gap-1 flex-wrap px-4 pt-3 pb-2 border-b border-gray-200 dark:border-gray-700 shrink-0"
      role="tablist"
    >
      {withViewTabGroupHeaders(tabs).map(({ tab, groupHeader }) => {
        const isActive = tab.id === active;
        return (
          <span key={tab.id} className="flex items-center gap-1">
            {groupHeader && (
              <span className="ml-3 mr-1 first:ml-0 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 select-none">
                {groupHeader}
              </span>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(tab.id as T)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                isActive
                  ? "bg-brand-600 text-white"
                  : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              {tab.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
