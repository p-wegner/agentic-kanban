import { Icon, Spinner } from "./Icon.js";
interface EnhanceButtonProps {
  enhancing: boolean;
  disabled: boolean;
  onClick: () => void;
  className: string;
  /** Icon size classes — the panel renders these controls one step larger. */
  iconClassName?: string;
  label?: string;
  busyLabel?: string;
}

/**
 * The "Enhance with AI" trigger: sparkle icon, spinner while the request is in flight,
 * and the busy label. Shared by `CreateIssuePanel`, `CreateIssueForm` and
 * `IssueEditFooter` (#772) — all three had the same two SVGs and the same
 * `enhancing ? spinner : sparkle` branch inline, differing only in size and wording.
 */
export function EnhanceButton({
  enhancing,
  disabled,
  onClick,
  className,
  iconClassName = "h-3.5 w-3.5",
  label = "Enhance",
  busyLabel = "Enhancing...",
}: EnhanceButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title="Enhance with AI"
      className={className}
    >
      {enhancing ? (
        <Spinner className={`animate-spin ${iconClassName}`} />
      ) : (
        <Icon className={iconClassName} d="M5 3l1.5 3.5L10 8l-3.5 1.5L5 13l-1.5-3.5L0 8l3.5-1.5L5 3zM19 11l1 2.5L22.5 14l-2.5 1L19 17.5l-1-2.5L15.5 14l2.5-1L19 11z" />
      )}
      {enhancing ? busyLabel : label}
    </button>
  );
}

interface UndoEnhanceButtonProps {
  onClick: () => void;
  className: string;
  iconClassName?: string;
}

/** The Undo control shown once an enhancement has replaced the text. */
export function UndoEnhanceButton({ onClick, className, iconClassName = "h-3.5 w-3.5" }: UndoEnhanceButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Undo enhancement"
      className={className}
    >
      <Icon className={iconClassName} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
      Undo
    </button>
  );
}
