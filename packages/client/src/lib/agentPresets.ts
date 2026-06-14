export const AGENT_PRESETS_PREFIX = "agent_presets_";

export type PresetProvider = "claude" | "codex" | "copilot" | "pi";

export interface AgentPreset {
  id: string;
  name: string;
  provider: PresetProvider;
  /** Profile name for the provider. Empty/omitted = provider default. */
  profile?: string;
  /** Model override (Claude/Codex only). Empty/omitted = inherit default. */
  model?: string;
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function normalizeProvider(value: unknown): PresetProvider {
  return value === "codex" || value === "copilot" || value === "pi" ? value : "claude";
}

export function agentPresetsKey(projectId: string) {
  return `${AGENT_PRESETS_PREFIX}${projectId}`;
}

export function sanitizeAgentPresets(raw: string | undefined): AgentPreset[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): AgentPreset[] => {
      if (!isRecord(item)) return [];
      const id = optionalString(item.id);
      const name = optionalString(item.name);
      if (!id || !name) return [];
      return [{
        id,
        name: name.trim(),
        provider: normalizeProvider(item.provider),
        profile: optionalString(item.profile) ?? undefined,
        model: optionalString(item.model) ?? undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface AgentPresetInput {
  provider: PresetProvider;
  profile?: string;
  model?: string;
}

export function upsertAgentPreset(
  presets: AgentPreset[],
  name: string,
  input: AgentPresetInput,
  now = new Date().toISOString(),
): AgentPreset[] {
  const trimmed = name.trim();
  if (!trimmed) return presets;
  const existing = presets.find((p) => normalizeName(p.name) === normalizeName(trimmed));
  const next: AgentPreset = {
    id: existing?.id ?? `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    provider: input.provider,
    profile: input.profile?.trim() || undefined,
    model: input.model?.trim() || undefined,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return [...presets.filter((p) => p.id !== next.id), next]
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteAgentPreset(presets: AgentPreset[], presetId: string): AgentPreset[] {
  return presets.filter((p) => p.id !== presetId);
}

/**
 * The combined `<provider>:<name>` profile token used by CreateWorkspaceForm's
 * "Agent Profile" dropdown / launch body. Codex/Copilot fall back to their
 * "default" profile name when none is set; Claude with no profile resolves to
 * an empty token (server/strategy default).
 */
export function presetProfileToken(preset: AgentPreset): string {
  if (preset.provider === "codex") return `codex:${preset.profile || "default"}`;
  if (preset.provider === "copilot") return `copilot:${preset.profile || "default"}`;
  if (preset.provider === "pi") return `pi:${preset.profile || "default"}`;
  return preset.profile ? `claude:${preset.profile}` : "";
}
