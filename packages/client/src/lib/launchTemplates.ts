export const LAUNCH_TEMPLATES_PREFIX = "launch_templates_";

export interface LaunchTemplate {
  id: string;
  name: string;
  options: LaunchTemplateOptions;
  createdAt: string;
  updatedAt: string;
}

export interface LaunchTemplateOptions {
  baseBranch?: string;
  selectedProfile?: string;
  selectedModel?: string;
  selectedSkillId?: string;
  planMode?: boolean;
  tddMode?: boolean;
  requiresReview?: boolean;
  skipSetup?: boolean;
  skipContextPacker?: boolean;
  isDirect?: boolean;
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

export function launchTemplatesKey(projectId: string) {
  return `${LAUNCH_TEMPLATES_PREFIX}${projectId}`;
}

export function sanitizeLaunchTemplates(raw: string | undefined): LaunchTemplate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): LaunchTemplate[] => {
      if (!isRecord(item)) return [];
      const id = optionalString(item.id);
      const name = optionalString(item.name);
      if (!id || !name) return [];
      const opts = isRecord(item.options) ? item.options : {};
      return [{
        id,
        name: name.trim(),
        options: {
          baseBranch: optionalString(opts.baseBranch) ?? undefined,
          selectedProfile: optionalString(opts.selectedProfile) ?? undefined,
          selectedModel: optionalString(opts.selectedModel) ?? undefined,
          selectedSkillId: optionalString(opts.selectedSkillId) ?? undefined,
          planMode: opts.planMode === true ? true : undefined,
          tddMode: opts.tddMode === true ? true : undefined,
          requiresReview: opts.requiresReview === true ? true : undefined,
          skipSetup: opts.skipSetup === true ? true : undefined,
          skipContextPacker: opts.skipContextPacker === true ? true : undefined,
          isDirect: opts.isDirect === true ? true : undefined,
        },
        createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
      }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function upsertLaunchTemplate(
  templates: LaunchTemplate[],
  name: string,
  options: LaunchTemplateOptions,
  now = new Date().toISOString(),
): LaunchTemplate[] {
  const trimmed = name.trim();
  if (!trimmed) return templates;
  const existing = templates.find((t) => normalizeName(t.name) === normalizeName(trimmed));
  const next: LaunchTemplate = {
    id: existing?.id ?? `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    options,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  return [...templates.filter((t) => t.id !== next.id), next]
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteLaunchTemplate(templates: LaunchTemplate[], templateId: string): LaunchTemplate[] {
  return templates.filter((t) => t.id !== templateId);
}

/** Map template options into form-state setter calls. Returns a partial form state object. */
export function applyTemplateToForm(template: LaunchTemplate): LaunchTemplateOptions {
  return { ...template.options };
}
