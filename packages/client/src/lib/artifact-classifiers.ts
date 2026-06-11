import type { IssueArtifact } from "@agentic-kanban/shared";

export function phaseArtifactName(caption: string | null): string {
  const key = caption?.replace(/^phase-artifact:/, "").toLowerCase();
  if (key === "tasks") return "tasks.md";
  if (key === "design") return "design.md";
  return "spec.md";
}

export function isGithubHandoffDraft(artifact: IssueArtifact): boolean {
  return artifact.type === "text" && artifact.caption === "github-handoff-draft";
}

export function issueArtifactKind(artifact: IssueArtifact): string {
  if (isGithubHandoffDraft(artifact)) return "GitHub draft";
  if (artifact.caption?.startsWith("phase-artifact:")) return `Phase ${phaseArtifactName(artifact.caption)}`;
  if (artifact.caption) return artifact.caption;
  return artifact.type.charAt(0).toUpperCase() + artifact.type.slice(1);
}

export function issueArtifactAuthor(artifact: IssueArtifact): string {
  return artifact.workspaceId ? "agent" : "system";
}

export type IssueArtifactRendererType = "text" | "diff" | "image" | "link" | "video" | "other";

export function isDiffTextArtifact(artifact: IssueArtifact): boolean {
  if (artifact.type !== "text") return false;
  const caption = artifact.caption?.trim().toLowerCase() ?? "";
  const mime = artifact.mimeType?.trim().toLowerCase() ?? "";
  return caption === "diff" || caption === "patch" || caption === "unified-diff" || mime.includes("diff");
}

export function getIssueArtifactRenderer(artifact: IssueArtifact): IssueArtifactRendererType {
  if (isDiffTextArtifact(artifact)) return "diff";
  if (artifact.type === "text") return "text";
  if (artifact.type === "image") return "image";
  if (artifact.type === "link") return "link";
  if (artifact.type === "video") return "video";
  return "other";
}
