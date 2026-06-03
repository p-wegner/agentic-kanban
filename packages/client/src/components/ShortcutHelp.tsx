import { VIEW_REGISTRY, type ViewMode } from "../lib/viewRegistry.js";
import { SHORTCUT_REGISTRY, type ShortcutCategory } from "../lib/shortcutRegistry.js";

interface ShortcutHelpProps {
  onClose: () => void;
  currentView?: ViewMode;
}

interface Shortcut {
  keys: string[];
  description: string;
  sequential?: boolean;
}

export function ShortcutHelp({ onClose, currentView }: ShortcutHelpProps) {
  const view = VIEW_REGISTRY.find((v) => v.id === currentView);
  const viewShortcuts = currentView ? VIEW_SPECIFIC_SHORTCUTS[currentView] ?? [] : [];

  // Group non-view shortcuts by category from the registry
  const categories: ShortcutCategory[] = ["Navigation", "Board", "Panels"];
  const byCategory = Object.fromEntries(
    categories.map((cat) => [
      cat,
      SHORTCUT_REGISTRY.filter((s) => s.category === cat),
    ]),
  ) as Record<ShortcutCategory, Shortcut[]>;

  // View shortcuts derived from VIEW_REGISTRY — single source of truth (#116)
  const viewSwitchShortcuts: Shortcut[] = VIEW_REGISTRY.filter((v) => v.shortcut).map((v) => ({
    keys: v.chord ? ["g", v.shortcut as string] : [v.shortcut as string],
    description: `Switch to ${v.label}`,
    sequential: v.chord,
  }));

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-[12%] left-1/2 -translate-x-1/2 w-full max-w-lg bg-white dark:bg-gray-900 rounded-lg shadow-2xl z-50 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Keyboard Shortcuts{view ? ` — ${view.label}` : ""}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>
        <div className="py-2 max-h-[70vh] overflow-y-auto">
          {viewShortcuts.length > 0 && (
            <ShortcutSection title={`${view?.toolbarLabel ?? "View"} shortcuts`} shortcuts={viewShortcuts} />
          )}
          {categories.map((cat) =>
            byCategory[cat].length > 0 ? (
              <ShortcutSection key={cat} title={cat} shortcuts={byCategory[cat]} />
            ) : null,
          )}
          <ShortcutSection title="Views" shortcuts={viewSwitchShortcuts} />
        </div>
      </div>
    </>
  );
}

const VIEW_SPECIFIC_SHORTCUTS: Partial<Record<ViewMode, Shortcut[]>> = {
  butler: [
    { keys: ["Enter"], description: "Send message" },
    { keys: ["Ctrl", "Enter"], description: "Send message" },
    { keys: ["Shift", "Enter"], description: "Insert newline" },
    { keys: ["Ctrl", "Space"], description: "Hold to dictate" },
    { keys: ["Ctrl", "L"], description: "Clear Butler context" },
    { keys: ["Ctrl", "Shift", "X"], description: "Clear Butler context" },
    { keys: ["Ctrl", "P"], description: "Cycle Butler profile" },
    { keys: ["Ctrl", "M"], description: "Cycle Butler model" },
    { keys: ["Ctrl", "Shift", "N"], description: "New Butler session" },
    { keys: ["Escape"], description: "Close Butler panels / exit to Board when input is empty" },
  ],
};

function ShortcutSection({ title, shortcuts }: { title: string; shortcuts: Shortcut[] }) {
  return (
    <section className="py-1">
      <div className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {title}
      </div>
      {shortcuts.map((shortcut) => (
        <div
          key={`${title}-${shortcut.keys.join("+")}-${shortcut.description}`}
          className="flex items-center justify-between gap-4 px-4 py-2"
        >
          <span className="text-sm text-gray-700 dark:text-gray-300">{shortcut.description}</span>
          <div className="flex items-center gap-1 shrink-0">
            {shortcut.keys.map((key, i) => (
              <span key={i}>
                <kbd className="text-xs text-gray-500 dark:text-gray-400 px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 font-mono">
                  {key}
                </kbd>
                {i < shortcut.keys.length - 1 && (
                  <span className="text-xs text-gray-400 dark:text-gray-500 mx-0.5">
                    {shortcut.sequential ? "then" : "+"}
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
