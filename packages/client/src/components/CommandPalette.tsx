import { useEffect, useMemo, useRef, useState } from "react";
import { getActions, type Action, type ActionCategory } from "../lib/actions.js";

interface CommandPaletteProps {
  onClose: () => void;
}

const CATEGORY_LABELS: Record<ActionCategory, string> = {
  board: "Board",
  navigation: "Navigation",
  issue: "Issue",
  settings: "Settings",
};

const CATEGORY_ORDER: ActionCategory[] = ["issue", "board", "navigation", "settings"];

const CATEGORY_ICONS: Record<ActionCategory, string> = {
  issue: "◈",
  board: "⊞",
  navigation: "⇢",
  settings: "⚙",
};

const RECENT_KEY = "command-palette-recent";
const MAX_RECENT = 5;

function getRecentIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
}

function recordRecent(id: string) {
  const recent = getRecentIds().filter((r) => r !== id);
  recent.unshift(id);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const allActions = useMemo(() => getActions(), []);

  const filteredActions = useMemo(() => {
    if (!query) return allActions;
    const q = query.toLowerCase();
    return allActions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        CATEGORY_LABELS[a.category].toLowerCase().includes(q),
    );
  }, [query, allActions]);

  // When no query, show recent actions first, then rest grouped by category
  const displayGroups = useMemo(() => {
    if (query) {
      const groups: { category: ActionCategory; label: string; actions: Action[] }[] = [];
      for (const cat of CATEGORY_ORDER) {
        const catActions = filteredActions.filter((a) => a.category === cat);
        if (catActions.length > 0) {
          groups.push({ category: cat, label: CATEGORY_LABELS[cat], actions: catActions });
        }
      }
      return groups;
    }

    const recentIds = getRecentIds();
    const recentActions = recentIds
      .map((id) => allActions.find((a) => a.id === id))
      .filter(Boolean) as Action[];

    const groups: { category: ActionCategory | "recent"; label: string; actions: Action[] }[] = [];

    if (recentActions.length > 0) {
      groups.push({ category: "recent", label: "Recent", actions: recentActions });
    }

    for (const cat of CATEGORY_ORDER) {
      const catActions = allActions.filter(
        (a) => a.category === cat && !recentIds.includes(a.id),
      );
      if (catActions.length > 0) {
        groups.push({ category: cat, label: CATEGORY_LABELS[cat], actions: catActions });
      }
    }

    return groups;
  }, [query, filteredActions, allActions]);

  const flatActions = useMemo(
    () => displayGroups.flatMap((g) => g.actions),
    [displayGroups],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const selected = container.querySelector("[data-selected='true']") as HTMLElement;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flatActions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const action = flatActions[selectedIndex];
      if (action) {
        recordRecent(action.id);
        onClose();
        action.handler();
      }
      return;
    }
  }

  function handleActionClick(action: Action) {
    recordRecent(action.id);
    onClose();
    action.handler();
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50" onClick={onClose} />
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl z-50 border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <svg className="w-4 h-4 text-gray-400 dark:text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search actions..."
            className="flex-1 text-sm outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500 text-gray-900 dark:text-gray-100 bg-transparent"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1"
            >
              ✕
            </button>
          )}
          <kbd className="hidden sm:inline-flex text-[10px] text-gray-400 dark:text-gray-500 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 shrink-0">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1.5">
          {flatActions.length === 0 && (
            <div className="px-4 py-8 text-sm text-gray-400 dark:text-gray-500 text-center">
              No matching actions for &ldquo;{query}&rdquo;
            </div>
          )}
          {displayGroups.map((group) => (
            <div key={group.category}>
              <div className="flex items-center gap-1.5 px-4 py-1 mt-0.5">
                <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                  {group.category !== "recent" && (
                    <span className="mr-1">{CATEGORY_ICONS[group.category as ActionCategory]}</span>
                  )}
                  {group.label}
                </span>
              </div>
              {group.actions.map((action) => {
                const flatIndex = flatActions.indexOf(action);
                const isSelected = flatIndex === selectedIndex;
                return (
                  <div
                    key={action.id}
                    data-selected={isSelected}
                    className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-blue-50 dark:bg-blue-900/30 border-l-2 border-blue-500"
                        : "hover:bg-gray-50 dark:hover:bg-gray-800 border-l-2 border-transparent"
                    }`}
                    onClick={() => handleActionClick(action)}
                    onMouseEnter={() => setSelectedIndex(flatIndex)}
                  >
                    {/* Icon placeholder / category dot */}
                    <span className={`w-6 h-6 rounded flex items-center justify-center text-xs shrink-0 ${
                      isSelected ? "bg-blue-100 text-blue-600" : "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
                    }`}>
                      {action.icon ?? CATEGORY_ICONS[action.category]}
                    </span>

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {action.label}
                      </div>
                      {action.description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{action.description}</div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {action.shortcut && (
                        <kbd className="text-[10px] text-gray-400 dark:text-gray-500 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 font-mono">
                          {action.shortcut}
                        </kbd>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex items-center gap-3 text-[10px] text-gray-400 dark:text-gray-500">
            <span><kbd className="font-mono">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono">↵</kbd> select</span>
            <span><kbd className="font-mono">Esc</kbd> close</span>
          </div>
          <span className="text-[10px] text-gray-300 dark:text-gray-600">
            {flatActions.length} action{flatActions.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
    </>
  );
}
