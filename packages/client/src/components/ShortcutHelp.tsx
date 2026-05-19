interface ShortcutHelpProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: ["/"], description: "Focus search" },
  { keys: ["Ctrl", "K"], description: "Command palette" },
  { keys: ["Escape"], description: "Close panel / clear search" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["c"], description: "Create new issue" },
  { keys: ["w"], description: "New issue + start workspace" },
  { keys: ["t"], description: "Open Quick Tasks panel" },
  { keys: ["g", "s"], description: "Open settings" },
];

export function ShortcutHelp({ onClose }: ShortcutHelpProps) {
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50" onClick={onClose} />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-sm bg-white rounded-lg shadow-2xl z-50 border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Keyboard Shortcuts</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-lg leading-none"
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
              <span className="text-sm text-gray-700">{shortcut.description}</span>
              <div className="flex items-center gap-1">
                {shortcut.keys.map((key, i) => (
                  <span key={i}>
                    <kbd className="text-xs text-gray-500 px-1.5 py-0.5 bg-gray-100 rounded border border-gray-200 font-mono">
                      {key}
                    </kbd>
                    {i < shortcut.keys.length - 1 && (
                      <span className="text-xs text-gray-300 mx-0.5">+</span>
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
