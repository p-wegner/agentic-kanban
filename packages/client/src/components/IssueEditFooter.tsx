interface IssueEditFooterProps {
  title: string;
  saving: boolean;
  enhancing: boolean;
  /** Snapshot captured before an AI enhance, enabling the Undo button. */
  preEnhanceSnapshot: unknown;
  onSave: () => void;
  onCancel: () => void;
  onEnhance: () => void;
  onUndoEnhance: () => void;
}

/** Footer action bar shown while editing an issue: Save / Cancel and the AI
 *  Enhance (+ Undo) controls. Extracted verbatim from IssueDetailPanel. */
export function IssueEditFooter({
  title,
  saving,
  enhancing,
  preEnhanceSnapshot,
  onSave,
  onCancel,
  onEnhance,
  onUndoEnhance,
}: IssueEditFooterProps) {
  return (
    <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center gap-2">
      <button
        onClick={onSave}
        disabled={saving || !title.trim()}
        aria-label="Save issue changes"
        className="text-sm bg-brand-600 text-white px-4 py-1.5 rounded hover:bg-brand-700 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save"}
      </button>
      <button
        onClick={onCancel}
        className="text-sm text-gray-500 dark:text-gray-400 px-4 py-1.5 hover:text-gray-700 dark:hover:text-gray-300"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onEnhance}
        disabled={!title.trim() || enhancing}
        title="Enhance with AI"
        className="ml-auto text-sm text-brand-600 dark:text-brand-400 px-2 py-1.5 hover:text-brand-700 dark:hover:text-brand-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
      >
        {enhancing ? (
          <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
          </svg>
        )}
        {enhancing ? "Enhancing..." : "Enhance"}
      </button>
      {preEnhanceSnapshot ? (
        <button
          type="button"
          onClick={onUndoEnhance}
          title="Undo enhancement"
          className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1.5 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
          Undo
        </button>
      ) : null}
    </div>
  );
}
