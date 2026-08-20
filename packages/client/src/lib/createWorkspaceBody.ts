import type { ProfileSelection } from "@agentic-kanban/shared";
import { resolveQuickLaunchDefault } from "./workspace-helpers.js";
import { AGENT_PROVIDER_NAMES } from "@agentic-kanban/shared/lib/provider-traits";

// Pure construction of the POST /api/workspaces body from CreateWorkspaceForm
// state, plus the profile-selection parsing/default-resolution it depends on.
// Extracted so the payload rules (profile token parsing, default resolution,
// model/branch inclusion) are unit-testable; the form keeps only the async
// preflight/launch orchestration. (handleSubmit was CC 23.)

type AgentProvider = ProfileSelection["provider"];

// #493: the per-provider default-profile constants died with the ladder above, and the
// provider list is the shared table's. Note this one must still REJECT an unknown
// provider (see profileSelectionFromValue) rather than narrow it to claude.
const KNOWN_PROVIDERS: readonly string[] = AGENT_PROVIDER_NAMES;

/**
 * Resolve the "Default" profile selection to an explicit {provider, name} so the
 * server doesn't fall through to Strategy Bullseye — keeping the displayed label in
 * sync with what runs. Returns undefined when no specific default exists.
 */
export function resolveDefaultProfile(prefs: Record<string, string>): ProfileSelection | undefined {
  // #493: this was a byte-identical twin of `resolveQuickLaunchDefault`. Same rule,
  // including `undefined` meaning "no explicit default — let server/strategy decide".
  return resolveQuickLaunchDefault(prefs);
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
  /** Multi-repo scope (#91): repo ids the workspace spans; undefined = all (single-repo/direct). */
  repoScope?: string[];
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
    if (input.repoScope && input.repoScope.length > 0) body.repoScope = input.repoScope;
  }
  return body;
}
