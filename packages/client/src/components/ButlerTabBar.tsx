import { TabRenameInput } from "./ButlerChrome.js";

interface ButlerTabSummary {
  butlerState?: { active?: boolean } | null;
  sending?: boolean;
  butlerName?: string;
}

interface ButlerTabBarProps {
  openTabs: string[];
  tabStates: Record<string, ButlerTabSummary | undefined>;
  activeTabId: string;
  setActiveTabId: (id: string) => void;
  renamingTabId: string | null;
  setRenamingTabId: (id: string | null) => void;
  onRename: (tabId: string, value: string) => void;
  onCloseTab: (tabId: string) => void;
  canOpenMore: boolean;
  addTabRef: React.RefObject<HTMLDivElement | null>;
  addTabOpen: boolean;
  setAddTabOpen: React.Dispatch<React.SetStateAction<boolean>>;
  availableToOpen: { id: string; name: string; active: boolean }[];
  onOpenTab: (id: string, name: string) => void;
  onManage: () => void;
}

/** The Butler tab strip: open tabs (warm/sending indicators, inline rename,
 * close), the add-tab dropdown, and the manage-butlers gear. */
export function ButlerTabBar({
  openTabs,
  tabStates,
  activeTabId,
  setActiveTabId,
  renamingTabId,
  setRenamingTabId,
  onRename,
  onCloseTab,
  canOpenMore,
  addTabRef,
  addTabOpen,
  setAddTabOpen,
  availableToOpen,
  onOpenTab,
  onManage,
}: ButlerTabBarProps) {
  return (
    <div className="shrink-0 flex items-stretch border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 overflow-x-auto">
      {openTabs.map((tabId) => {
        const ts = tabStates[tabId];
        const isActive = tabId === activeTabId;
        const isWarm = ts?.butlerState?.active === true;
        const isSending = ts?.sending === true;
        const isRenaming = renamingTabId === tabId;
        const tabName = ts?.butlerName ?? tabId;

        return (
          <div
            key={tabId}
            className={`group flex items-center gap-1.5 px-3 py-2 border-r border-gray-200 dark:border-gray-800 cursor-pointer select-none shrink-0 ${
              isActive
                ? "bg-white dark:bg-gray-900 border-b-2 border-b-brand-500 -mb-px text-gray-800 dark:text-gray-100"
                : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400"
            }`}
            onClick={() => { if (!isRenaming) setActiveTabId(tabId); }}
            data-testid={`butler-tab-${tabId}`}
          >
            {/* Warm session indicator */}
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                isSending ? "bg-green-500 animate-pulse" : isWarm ? "bg-green-400" : "bg-gray-300 dark:bg-gray-600"
              }`}
              title={isSending ? "Butler is thinking" : isWarm ? "Warm session" : "No session"}
            />
            {isRenaming ? (
              <TabRenameInput
                name={tabName}
                onSave={(v) => { setRenamingTabId(null); onRename(tabId, v); }}
                onCancel={() => setRenamingTabId(null)}
              />
            ) : (
              <span
                className="text-xs font-medium max-w-[120px] truncate"
                onDoubleClick={(e) => { e.stopPropagation(); setRenamingTabId(tabId); }}
                title={`${tabName} — double-click to rename`}
              >
                {tabName}
              </span>
            )}
            {/* Close tab */}
            {openTabs.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); onCloseTab(tabId); }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-opacity"
                title="Close tab"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            )}
          </div>
        );
      })}

      {/* Add tab dropdown — click-controlled (a hover-only menu dropped its
          :hover crossing the gap to the menu, so the click never landed, #842) */}
      {canOpenMore && (
        <div ref={addTabRef} className="relative shrink-0 flex items-center">
          <button
            type="button"
            onClick={() => setAddTabOpen((o) => !o)}
            className="flex items-center gap-1 px-2.5 py-2 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 text-xs transition-colors"
            title="Open another butler in a new tab"
            aria-haspopup="menu"
            aria-expanded={addTabOpen}
            data-testid="butler-add-tab"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          {/* Dropdown to pick which butler to open */}
          {addTabOpen && (
            <div role="menu" className="absolute top-full left-0 mt-0.5 z-30 rounded-md shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 py-1 min-w-[140px]">
              {availableToOpen.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="menuitem"
                  onClick={() => { onOpenTab(b.id, b.name); setAddTabOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center gap-2"
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${b.active ? "bg-green-400" : "bg-gray-300 dark:bg-gray-600"}`} />
                  {b.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manage butlers gear */}
      <button
        onClick={onManage}
        className="ml-auto shrink-0 px-2.5 py-2 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        title="Manage butlers (add, rename, set model, remove)"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
        </svg>
      </button>
    </div>
  );
}
