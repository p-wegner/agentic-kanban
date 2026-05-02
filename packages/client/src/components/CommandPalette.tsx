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

const CATEGORY_ORDER: ActionCategory[] = ["board", "navigation", "issue", "settings"];

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredActions = useMemo(() => {
    const all = getActions();
    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter((a) => a.label.toLowerCase().includes(q));
  }, [query]);

  // Group by category
  const grouped = useMemo(() => {
    const groups: { category: ActionCategory; actions: Action[] }[] = [];
    for (const cat of CATEGORY_ORDER) {
      const catActions = filteredActions.filter((a) => a.category === cat);
      if (catActions.length > 0) {
        groups.push({ category: cat, actions: catActions });
      }
    }
    return groups;
  }, [filteredActions]);

  // Flat list for index tracking
  const flatActions = useMemo(() => {
    return grouped.flatMap((g) => g.actions);
  }, [grouped]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

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
        onClose();
        action.handler();
      }
      return;
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-md bg-white rounded-lg shadow-2xl z-50 border border-gray-200 overflow-hidden">
        <div className="px-3 py-2 border-b border-gray-200">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="w-full text-sm outline-none placeholder:text-gray-400"
          />
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {flatActions.length === 0 && (
            <div className="px-3 py-4 text-sm text-gray-400 text-center">
              No matching commands
            </div>
          )}
          {grouped.map((group) => (
            <div key={group.category}>
              <div className="px-3 py-1 text-[10px] font-medium text-gray-400 uppercase tracking-wide">
                {CATEGORY_LABELS[group.category]}
              </div>
              {group.actions.map((action) => {
                const flatIndex = flatActions.indexOf(action);
                const isSelected = flatIndex === selectedIndex;
                return (
                  <div
                    key={action.id}
                    className={`flex items-center justify-between px-3 py-1.5 cursor-pointer ${
                      isSelected ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                    onClick={() => {
                      onClose();
                      action.handler();
                    }}
                    onMouseEnter={() => setSelectedIndex(flatIndex)}
                  >
                    <span className="text-sm text-gray-900">{action.label}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400 px-1 py-0.5 bg-gray-100 rounded">
                        {CATEGORY_LABELS[action.category]}
                      </span>
                      {action.shortcut && (
                        <kbd className="text-[10px] text-gray-400 px-1 py-0.5 bg-gray-100 rounded border border-gray-200">
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
      </div>
    </>
  );
}
