import { VIEW_REGISTRY, type ViewMode } from "../lib/viewRegistry.js";

interface ShortcutHelpProps {
  onClose: () => void;
  currentView?: ViewMode;
}

// View-switch shortcuts are derived from the canonical view registry (#116) so
// the overlay never drifts out of sync with the toolbar and command palette.
const VIEW_SHORTCUTS: Array<{ keys: string[]; description: string }> = VIEW_REGISTRY.filter(
  (v) => v.shortcut,
).map((v) => ({ keys: [v.shortcut as string], description: `Switch to ${v.label}` }));

interface Shortcut {
  keys: string[];
  description: string;
  sequential?: boolean;
}

const GLOBAL_SHORTCUTS: Shortcut[] = [
  { keys: ["/"], description: "Focus search" },
  { keys: ["Ctrl", "K"], description: "Command palette" },
  { keys: ["Escape"], description: "Close panel / clear search / go back" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["c"], description: "Create new issue" },
  { keys: ["w"], description: "New issue + start workspace" },
  { keys: ["q"], description: "Open Quick Tasks panel" },
  { keys: ["Shift", "V"], description: "Start voice inbox (record idea → Backlog issue)" },
  ...VIEW_SHORTCUTS,
  { keys: ["a"], description: "Toggle All Workspaces panel" },
  { keys: ["h"], description: "Toggle File Contention Heatmap" },
  { keys: ["t"], description: "Search agent transcripts" },
  { keys: ["x"], description: "Open Codemod Factory" },
  { keys: ["g", "s"], description: "Open settings", sequential: true },
];

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

export function ShortcutHelp({ onClose, currentView }: ShortcutHelpProps) {
  const view = VIEW_REGISTRY.find((v) => v.id === currentView);
  const viewShortcuts = currentView ? VIEW_SPECIFIC_SHORTCUTS[currentView] ?? [] : [];

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-[12%] left-1/2 -translate-x-1/2 w-full max-w-md bg-white dark:bg-gray-900 rounded-lg shadow-2xl z-50 border border-gray-200 dark:border-gray-700 overflow-hidden">
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
          <ShortcutSection title="Global shortcuts" shortcuts={GLOBAL_SHORTCUTS} />
        </div>
      </div>
    </>
  );
}

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
                    {shortcut.sequential ? "→" : "+"}
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
