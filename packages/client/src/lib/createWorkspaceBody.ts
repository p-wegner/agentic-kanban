import type { ProfileSelection } from "@agentic-kanban/shared";

// Pure construction of the POST /api/workspaces body from CreateWorkspaceForm
// state, plus the profile-selection parsing/default-resolution it depends on.
// Extracted so the payload rules (profile token parsing, default resolution,
// model/branch inclusion) are unit-testable; the form keeps only the async
// preflight/launch orchestration. (handleSubmit was CC 23.)

type AgentProvider = ProfileSelection["provider"];

const CODEX_DEFAULT_PROFILE = "default";
const COPILOT_DEFAULT_PROFILE = "default";
const PI_DEFAULT_PROFILE = "default";

const KNOWN_PROVIDERS: AgentProvider[] = ["claude", "codex", "copilot", "pi"];

/**
 * Resolve the "Default" profile selection to an explicit {provider, name} so the
 * server doesn't fall through to Strategy Bullseye — keeping the displayed label in
 * sync with what runs. Returns undefined when no specific default exists.
 */
export function resolveDefaultProfile(prefs: Record<string, string>): ProfileSelection | undefined {
  if (prefs.provider === "codex") return { provider: "codex", name: prefs.codex_profile || CODEX_DEFAULT_PROFILE };
  if (prefs.provider === "copilot") return { provider: "copilot", name: prefs.copilot_profile || COPILOT_DEFAULT_PROFILE };
  if (prefs.provider === "pi") return { provider: "pi", name: prefs.pi_profile || PI_DEFAULT_PROFILE };
  if (prefs.claude_profile) return { provider: "claude", name: prefs.claude_profile };
  return undefined; // No explicit default — let server/strategy decide
}

/** Parse a "provider:name" selection token into a ProfileSelection, or null if malformed. */
export function parseProfileSelection(selectedProfile: string): ProfileSelection | null {
  const colonIdx = selectedProfile.indexOf(":");
  if (colonIdx === -1) return null;
  const provider = selectedProfile.slice(0, colonIdx) as AgentProvider;
  const name = selectedProfile.slice(colonIdx + 1);
  if (KNOWN_PROVIDERS.includes(provider) && name) return { provider, name };
  return null;
}

export interface CreateWorkspaceBodyInput {
  issueId: string;
  isDirect: boolean;
  requiresReview: boolean;
  planMode: boolean;
  tddMode: boolean;
  includeVisualProof: boolean;
  skipSetup: boolean;
  skipContextPacker: boolean;
  selectedSkillId: string;
  /** "" = the "Default" option; otherwise a "provider:name" token. */
  selectedProfile: string;
  selectedModel: string;
  /** Whether a model override applies (Claude/Codex selected). */
  modelApplies: boolean;
  branchName: string;
  baseBranch: string;
  prefs: Record<string, string>;
}

/** Build the workspace-create request body from form state (no side effects). */
export function buildCreateWorkspaceBody(input: CreateWorkspaceBodyInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    issueId: input.issueId,
    isDirect: input.isDirect,
    requiresReview: input.requiresReview,
    planMode: input.planMode,
    tddMode: input.tddMode,
    includeVisualProof: input.includeVisualProof,
    skipSetup: input.skipSetup,
    skipContextPacker: input.skipContextPacker,
  };
  if (input.selectedSkillId) body.skillId = input.selectedSkillId;
  if (input.selectedProfile) {
    const profile = parseProfileSelection(input.selectedProfile);
    if (profile) body.profile = profile;
  } else {
    // "Default" selected — resolve to the explicit global default.
    const resolved = resolveDefaultProfile(input.prefs);
    if (resolved) body.profile = resolved;
  }
  if (input.modelApplies && input.selectedModel) body.model = input.selectedModel;
  if (!input.isDirect) {
    body.branch = input.branchName.trim();
    if (input.baseBranch.trim()) body.baseBranch = input.baseBranch.trim();
  }
  return body;
}
