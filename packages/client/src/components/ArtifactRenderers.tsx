import ReactMarkdown from "react-markdown";
import type { IssueArtifact } from "@agentic-kanban/shared";
import { DEFAULT_ARTIFACT_PREVIEW_LENGTH, issueArtifactPreview, normalizeMarkdown } from "../lib/artifact-utils.js";
import type { IssueArtifactRendererType } from "../lib/artifact-classifiers.js";

export interface IssueArtifactRendererProps {
  artifact: IssueArtifact;
  expanded: boolean;
  previewLength?: number;
}

export function DiffArtifact({ artifact, expanded, previewLength = DEFAULT_ARTIFACT_PREVIEW_LENGTH }: IssueArtifactRendererProps) {
  return (
    <>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
        {issueArtifactPreview(artifact, previewLength)}
      </p>
      {expanded && (
        <pre className="mt-2 max-h-80 overflow-y-auto text-xs text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-900 p-2 rounded border border-gray-200 dark:border-gray-700 whitespace-pre-wrap">
          {artifact.content}
        </pre>
      )}
    </>
  );
}

export function TextArtifact({ artifact, expanded, previewLength = DEFAULT_ARTIFACT_PREVIEW_LENGTH }: IssueArtifactRendererProps) {
  return (
    <>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
        {issueArtifactPreview(artifact, previewLength)}
      </p>
      {expanded && (
        <div className="markdown-body mt-2 max-h-80 overflow-y-auto text-sm">
          <ReactMarkdown>{normalizeMarkdown(artifact.content)}</ReactMarkdown>
        </div>
      )}
    </>
  );
}

export function ImageArtifact({ artifact, expanded, previewLength = DEFAULT_ARTIFACT_PREVIEW_LENGTH }: IssueArtifactRendererProps) {
  return (
    <>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
        {issueArtifactPreview(artifact, previewLength)}
      </p>
      {expanded && (
        <a href={artifact.content} target="_blank" rel="noreferrer" className="block mt-2 max-h-80 overflow-y-auto">
          <img
            src={artifact.content}
            alt={artifact.caption || "artifact image"}
            className="max-w-full rounded border border-gray-200 dark:border-gray-700"
          />
        </a>
      )}
    </>
  );
}

export function LinkArtifact({ artifact, expanded }: IssueArtifactRendererProps) {
  return (
    <>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2 break-all">
        {issueArtifactPreview(artifact)}
      </p>
      {expanded && (
        <a
          href={artifact.content}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block break-all text-blue-600 hover:text-blue-700 dark:text-blue-400"
        >
          {artifact.content}
        </a>
      )}
    </>
  );
}

export function VideoArtifact({ artifact, expanded, previewLength = DEFAULT_ARTIFACT_PREVIEW_LENGTH }: IssueArtifactRendererProps) {
  return (
    <>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
        {issueArtifactPreview(artifact, previewLength)}
      </p>
      {expanded && (
        <video
          src={artifact.content}
          controls
          className="mt-2 max-h-80 w-full rounded border border-gray-200 dark:border-gray-700"
        >
          Your browser does not support the video tag.
        </video>
      )}
    </>
  );
}

export function UnknownArtifact({ artifact, expanded, previewLength = DEFAULT_ARTIFACT_PREVIEW_LENGTH }: IssueArtifactRendererProps) {
  return (
    <>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
        {issueArtifactPreview(artifact, previewLength)}
      </p>
      {expanded && (
        <div className="markdown-body mt-2 max-h-80 overflow-y-auto text-sm break-all">
          {artifact.content}
        </div>
      )}
    </>
  );
}

export const issueArtifactRenderers: Record<IssueArtifactRendererType, (props: IssueArtifactRendererProps) => JSX.Element> = {
  text: TextArtifact,
  diff: DiffArtifact,
  image: ImageArtifact,
  link: LinkArtifact,
  video: VideoArtifact,
  other: UnknownArtifact,
};
