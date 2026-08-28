import { Icon } from "./Icon.js";
import type { ProjectListItem as Project } from "../lib/projectTypes.js";

/**
 * The header's per-project destructive actions (archive, unregister), lifted out of
 * `Layout` verbatim.
 *
 * Extracted because `Layout` is on the shrink-only nloc ring (#763) at 708 nloc, and
 * #912's risk-posture chip could not be added without pushing it to 710. Bumping the
 * baseline would have defeated the guard's stated property — "the functions that are
 * genuinely unreadable may not get worse" — so the two inline `<button>` blocks moved
 * here instead. Both are pure presentation over props with no state of their own, which
 * is why they were the cheapest ~22 lines to remove without touching behaviour: the
 * confirmation dialogs and their state stay in `Layout`, and this component only asks
 * for the project to confirm ON.
 */
export function ProjectActionButtons({
  projects,
  activeProjectId,
  onArchiveProject,
  onUnregisterProject,
  onConfirmArchive,
  onConfirmUnregister,
}: {
  projects: Project[];
  activeProjectId: string | null;
  onArchiveProject?: (id: string) => Promise<void>;
  onUnregisterProject?: (id: string) => Promise<void>;
  onConfirmArchive: (project: Project) => void;
  onConfirmUnregister: (project: Project) => void;
}) {
  if (projects.length === 0) return null;
  const active = () => projects.find((p) => p.id === activeProjectId) ?? projects[0];
  return (
    <>
      {onArchiveProject && (
        <button
          onClick={() => onConfirmArchive(active())}
          className="hidden sm:inline-flex p-2.5 sm:p-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-amber-500 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Archive project"
        >
          <Icon className="h-4 w-4" d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
        </button>
      )}
      {onUnregisterProject && (
        <button
          onClick={() => onConfirmUnregister(active())}
          className="hidden sm:inline-flex p-2.5 sm:p-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 items-center justify-center text-gray-400 dark:text-gray-500 hover:text-red-500 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
          title="Unregister project"
        >
          <Icon
            className="h-4 w-4"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
          />
        </button>
      )}
    </>
  );
}
