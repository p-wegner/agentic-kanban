import type { IssueArtifact } from "@agentic-kanban/shared";

// Some issues were created via MCP/CLI calls whose JSON descriptions ended up
// with literal `\n` / `\t` sequences rather than real newlines. Unescape when
// the string has no real newlines so ReactMarkdown can render headings/lists.
export function normalizeMarkdown(s: string): string {
  if (s.includes("\n")) return s;
  return s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

export const DEFAULT_ARTIFACT_PREVIEW_LENGTH = 140;

export function artifactPreviewSource(artifact: IssueArtifact): string {
  return artifact.type === "text" ? normalizeMarkdown(artifact.content) : artifact.caption || artifact.content;
}

export function sanitizeArtifactPreview(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>\-[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function issueArtifactPreview(artifact: IssueArtifact, maxLength = DEFAULT_ARTIFACT_PREVIEW_LENGTH): string {
  const preview = sanitizeArtifactPreview(artifactPreviewSource(artifact));
  if (!preview) return artifact.type === "text" ? "Empty text artifact" : artifact.content;
  return preview.length > maxLength ? `${preview.slice(0, maxLength - 1).trimEnd()}...` : preview;
}
