import type { CreateIssueRequest, IssueEstimate, ProfileSelection } from "@agentic-kanban/shared";
import { parseProfileSelection, resolveDefaultProfile } from "./createWorkspaceBody.js";

// Pure construction of the create-issue submit payload from CreateIssuePanel state.
// Reuses the shared profile parse/default-resolution (previously duplicated here as
// an inline profileSelection()), and gates the workspace-launch fields on `start`.
// Extracted so the payload rules are unit-testable; the panel keeps only async submit.

export type CreateIssueSubmitData = CreateIssueRequest & {
  startWorkspace?: boolean;
  planMode?: boolean;
  skipAutoReview?: boolean;
  profile?: ProfileSelection;
  model?: string;
  isDirect?: boolean;
  skillId?: string;
};

/** The profile to launch with: a parsed selection token, else the resolved global default. */
export function resolveProfileSelection(selectedProfile: string, settings: Record<string, string>): ProfileSelection | undefined {
  if (selectedProfile) return parseProfileSelection(selectedProfile) ?? undefined;
  return resolveDefaultProfile(settings);
}

export interface CreateIssuePayloadInput {
  title: string;
  description: string;
  issueType: CreateIssueRequest["issueType"];
  estimate: IssueEstimate | "";
  statusId: string;
  projectId: string;
  /** Whether a workspace should be launched on create (checkbox or force). */
  start: boolean;
  planMode: boolean;
  skipAutoReview: boolean;
  isDirect: boolean;
  selectedProfile: string;
  selectedModel: string;
  skillId: string;
  /** Whether a model override applies (Claude/Codex selected). */
  modelApplies: boolean;
  settings: Record<string, string>;
  /** Repos this issue touches (#94, multi-repo authoring). Empty for single-repo projects. */
  reposTouched?: string[];
}

/** Build the create-issue submit payload (no side effects). Launch fields are
 *  undefined unless `start` is true, matching the server's "fields only when starting". */
export function buildCreateIssuePayload(i: CreateIssuePayloadInput): CreateIssueSubmitData {
  return {
    title: i.title.trim(),
    description: i.description.trim() || undefined,
    issueType: i.issueType,
    estimate: i.estimate || undefined,
    statusId: i.statusId,
    projectId: i.projectId,
    startWorkspace: i.start || undefined,
    planMode: (i.start && i.planMode) || undefined,
    skipAutoReview: (i.start && i.skipAutoReview) || undefined,
    profile: i.start ? resolveProfileSelection(i.selectedProfile, i.settings) : undefined,
    model: (i.start && i.modelApplies && i.selectedModel) || undefined,
    isDirect: (i.start && i.isDirect) || undefined,
    skillId: (i.start && i.skillId) || undefined,
    reposTouched: i.reposTouched && i.reposTouched.length > 0 ? i.reposTouched : undefined,
  };
}
