interface ShortcutHelpProps {
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string[]; description: string; sequential?: boolean }> = [
  { keys: ["/"], description: "Focus search" },
  { keys: ["Ctrl", "K"], description: "Command palette" },
  { keys: ["Escape"], description: "Close panel / clear search" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["c"], description: "Create new issue" },
  { keys: ["w"], description: "New issue + start workspace" },
  { keys: ["q"], description: "Open Quick Tasks panel" },
  { keys: ["Shift", "V"], description: "Start voice inbox (record idea → Backlog issue)" },
  { keys: ["b"], description: "Switch to Board view" },
  { keys: ["g"], description: "Switch to Graph view" },
  { keys: ["t"], description: "Switch to Table view" },
  { keys: ["f"], description: "Switch to Timeline view" },
  { keys: ["l"], description: "Switch to Agents view" },
  { keys: ["m"], description: "Switch to Metrics view" },
  { keys: ["i"], description: "Switch to Butler chat" },
  { keys: ["p"], description: "Switch to Swimlane view" },
  { keys: ["a"], description: "Toggle All Workspaces panel" },
  { keys: ["x"], description: "Open Codemod Factory" },
  { keys: ["g", "s"], description: "Open settings", sequential: true },
];

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-sm bg-white dark:bg-gray-900 rounded-lg shadow-2xl z-50 border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Keyboard Shortcuts</h3>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-lg leading-none"
          >
            &times;
          </button>
        </div>
        <div className="py-2">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.keys.join("+")}
              className="flex items-center justify-between px-4 py-2"
            >
              <span className="text-sm text-gray-700 dark:text-gray-300">{shortcut.description}</span>
              <div className="flex items-center gap-1">
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
        </div>
      </div>
    </>
  );
}
