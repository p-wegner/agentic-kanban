import type { IssueArtifact } from "@agentic-kanban/shared";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { getIssueArtifactRenderer, issueArtifactAuthor, issueArtifactKind } from "../lib/artifact-classifiers.js";
import { issueArtifactRenderers } from "./ArtifactRenderers.js";

export async function copyIssueArtifactContent(
  artifact: IssueArtifact,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator !== "undefined" ? navigator.clipboard : undefined,
): Promise<boolean> {
  if (!clipboard) return false;
  await clipboard.writeText(artifact.content);
  return true;
}

export function openIssueArtifact(
  artifact: IssueArtifact,
  opener: ((url: string, target?: string, features?: string) => unknown) | undefined = typeof window !== "undefined" ? window.open.bind(window) : undefined,
): boolean {
  if (!opener || artifact.type === "text") return false;
  opener(artifact.content, "_blank", "noopener,noreferrer");
  return true;
}

interface IssueArtifactsSectionProps {
  artifacts: IssueArtifact[];
  loading: boolean;
  expandedArtifactId: string | null;
  deletingArtifactId?: string | null;
  onOpen: (artifact: IssueArtifact) => void;
  onCopy: (artifact: IssueArtifact) => void;
  onDelete: (artifact: IssueArtifact) => void;
}

export function IssueArtifactsSection({
  artifacts,
  loading,
  expandedArtifactId,
  deletingArtifactId = null,
  onOpen,
  onCopy,
  onDelete,
}: IssueArtifactsSectionProps) {
  const orderedArtifacts = [...artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
      <div className="flex items-center justify-between gap-2 mb-2">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Artifacts
        </label>
        {!loading && artifacts.length > 0 && (
          <span className="text-[11px] text-gray-400 dark:text-gray-500">
            {artifacts.length}
          </span>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading artifacts...</p>
      ) : orderedArtifacts.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-gray-500">No generated artifacts yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {orderedArtifacts.map((artifact) => {
            const expanded = expandedArtifactId === artifact.id;
            const ArtifactRenderer = issueArtifactRenderers[getIssueArtifactRenderer(artifact)];
            return (
              <li
                key={artifact.id}
                className="border border-gray-200 dark:border-gray-700 rounded px-2.5 py-2 bg-gray-50 dark:bg-gray-800/50"
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                    {issueArtifactKind(artifact)}
                  </span>
                  <span className="text-gray-400 dark:text-gray-500 capitalize">{issueArtifactAuthor(artifact)}</span>
                  <span className="text-gray-400 dark:text-gray-500 ml-auto">{formatRelativeTime(artifact.createdAt)}</span>
                </div>
                <ArtifactRenderer artifact={artifact} expanded={expanded} />
                <div className="mt-1.5 flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={() => onOpen(artifact)}
                    className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {expanded ? "Close" : "Open"}
                  </button>
                  <button
                    type="button"
                    onClick={() => onCopy(artifact)}
                    className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(artifact)}
                    disabled={deletingArtifactId === artifact.id}
                    className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 disabled:opacity-50"
                  >
                    {deletingArtifactId === artifact.id ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
