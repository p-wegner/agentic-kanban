import type { ProjectRepoResponse, UpdateProjectRepoRequest } from "@agentic-kanban/shared";

/** Editable per-repo fields, as held in the RepoEditRow form (strings, never null). */
export interface RepoEditFormState {
  name: string;
  setupScript: string;
  composeFile: string;
}

/** Seed the edit form from a fetched repo row (null → empty string). */
export function repoFormFromResponse(repo: ProjectRepoResponse): RepoEditFormState {
  return {
    name: repo.name ?? "",
    setupScript: repo.setupScript ?? "",
    composeFile: repo.composeFile ?? "",
  };
}

/** Normalize a nullable text field: blank (after trim) means "cleared" → null. */
function normNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build a minimal PATCH payload from the original vs. edited form state (#90).
 * Only fields that actually changed are included, so unchanged fields are never
 * clobbered on the server. `name` is only sent when it changed (and is trimmed);
 * empty-name validation is the caller's / server's job.
 */
export function buildRepoPatch(
  original: RepoEditFormState,
  next: RepoEditFormState,
): UpdateProjectRepoRequest {
  const patch: UpdateProjectRepoRequest = {};

  if (next.name.trim() !== original.name.trim()) {
    patch.name = next.name.trim();
  }

  const origSetup = normNullable(original.setupScript);
  const nextSetup = normNullable(next.setupScript);
  if (nextSetup !== origSetup) patch.setupScript = nextSetup;

  const origCompose = normNullable(original.composeFile);
  const nextCompose = normNullable(next.composeFile);
  if (nextCompose !== origCompose) patch.composeFile = nextCompose;

  return patch;
}
