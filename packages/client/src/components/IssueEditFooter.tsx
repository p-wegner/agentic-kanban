import { EnhanceButton, UndoEnhanceButton } from "./EnhanceActions.js";

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
      <EnhanceButton
        enhancing={enhancing}
        disabled={!title.trim() || enhancing}
        onClick={onEnhance}
        className="ml-auto text-sm text-brand-600 dark:text-brand-400 px-2 py-1.5 hover:text-brand-700 dark:hover:text-brand-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
      />
      {preEnhanceSnapshot ? (
        <UndoEnhanceButton
          onClick={onUndoEnhance}
          className="text-sm text-gray-500 dark:text-gray-400 px-2 py-1.5 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1"
        />
      ) : null}
    </div>
  );
}
