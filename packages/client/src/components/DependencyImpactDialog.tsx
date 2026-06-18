import type { DependencyItem } from "@agentic-kanban/shared";

interface DependencyImpactDialogProps {
  issueId: string;
  fromStatusName: string;
  toStatusName: string;
  dependencies: DependencyItem[];
  onConfirm: () => void;
  onCancel: () => void;
}

const RESOLVED_STATUSES = ["done", "cancelled", "ai reviewed"];

function isResolved(statusName: string) {
  return RESOLVED_STATUSES.includes(statusName.toLowerCase());
}

function ImpactSection({
  title,
  items,
  colorClass,
  dotClass,
}: {
  title: string;
  items: { number: number | null; title: string; statusName: string; note?: string }[];
  colorClass: string;
  dotClass: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`rounded-md border px-3 py-2.5 text-sm ${colorClass}`}>
      <div className="font-medium mb-1.5">{title}</div>
      <ul className="space-y-1 pl-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className={`mt-0.5 shrink-0 ${dotClass}`}>•</span>
            <span>
              {item.number != null && (
                <span className="font-mono text-xs mr-1">#{item.number}</span>
              )}
              <span className="truncate">{item.title}</span>
              <span className="ml-1 text-xs opacity-70">({item.statusName})</span>
              {item.note && <span className="ml-1 text-xs font-medium">{item.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DependencyImpactDialog({
  issueId,
  fromStatusName,
  toStatusName,
  dependencies,
  onConfirm,
  onCancel,
}: DependencyImpactDialogProps) {
  const movingToResolved = isResolved(toStatusName);

  // Blockers: issues this issue depends on that are not yet resolved
  const blockers = dependencies.filter((dep) => {
    const isOutgoing = dep.issueId === issueId;
    const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
    return isOutgoing && isBlockingType && !isResolved(dep.issueStatusName ?? "");
  });

  // Dependents: issues that depend on this one (they are waiting for this issue)
  const dependents = dependencies.filter((dep) => {
    const isIncoming = dep.issueId !== issueId;
    const isBlockingType = dep.type === "depends_on" || dep.type === "blocked_by";
    return isIncoming && isBlockingType;
  });

  // Parent/child relationships
  const parents = dependencies.filter(
    (dep) => dep.issueId === issueId && dep.type === "child_of"
  );
  const children = dependencies.filter(
    (dep) => dep.issueId === issueId && dep.type === "parent_of"
  );

  const hasAnyImpact = blockers.length > 0 || dependents.length > 0 || parents.length > 0 || children.length > 0;

  const unblockedDependents = movingToResolved
    ? dependents.filter((dep) => !isResolved(dep.issueStatusName ?? ""))
    : [];

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] flex flex-col p-6">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1 shrink-0">
          Move to {toStatusName}
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4 shrink-0">
          Review dependency relationships affected by moving from{" "}
          <span className="font-medium">{fromStatusName}</span> to{" "}
          <span className="font-medium">{toStatusName}</span>.
        </p>

        <div className="flex flex-col gap-2 mb-4 overflow-y-auto">
          {!hasAnyImpact && (
            <div className="text-sm text-gray-500 dark:text-gray-400 italic">
              No blocking dependencies affected by this move.
            </div>
          )}
          <ImpactSection
            title={`Blocked by ${blockers.length} unresolved ${blockers.length === 1 ? "dependency" : "dependencies"}`}
            items={blockers.map((d) => ({
              number: d.issueNumber,
              title: d.issueTitle,
              statusName: d.issueStatusName,
              note: "still open",
            }))}
            colorClass="bg-amber-50 border-amber-300 text-amber-800"
            dotClass="text-amber-500"
          />

          {unblockedDependents.length > 0 && (
            <ImpactSection
              title={`Unblocks ${unblockedDependents.length} waiting ${unblockedDependents.length === 1 ? "issue" : "issues"}`}
              items={unblockedDependents.map((d) => ({
                number: d.issueNumber,
                title: d.issueTitle,
                statusName: d.issueStatusName,
                note: "will be unblocked",
              }))}
              colorClass="bg-green-50 border-green-300 text-green-800"
              dotClass="text-green-600"
            />
          )}

          {dependents.length > 0 && unblockedDependents.length === 0 && (
            <ImpactSection
              title={`${dependents.length} ${dependents.length === 1 ? "issue depends" : "issues depend"} on this`}
              items={dependents.map((d) => ({
                number: d.issueNumber,
                title: d.issueTitle,
                statusName: d.issueStatusName,
              }))}
              colorClass="bg-blue-50 border-blue-200 text-blue-800"
              dotClass="text-blue-400"
            />
          )}

          {parents.length > 0 && (
            <ImpactSection
              title="Parent issues"
              items={parents.map((d) => ({
                number: d.issueNumber,
                title: d.issueTitle,
                statusName: d.issueStatusName,
              }))}
              colorClass="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
              dotClass="text-gray-400"
            />
          )}

          {children.length > 0 && (
            <ImpactSection
              title="Child issues"
              items={children.map((d) => ({
                number: d.issueNumber,
                title: d.issueTitle,
                statusName: d.issueStatusName,
              }))}
              colorClass="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300"
              dotClass="text-gray-400"
            />
          )}
        </div>

        <div className="flex gap-2 shrink-0">
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2 rounded-md bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 transition-colors"
          >
            Continue
          </button>
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 rounded-md border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
