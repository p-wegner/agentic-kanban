import type { WorkerSettings, WorkerSettingKey } from "@agentic-kanban/shared/lib/worker-settings";

/** The settings form's text state (#1381). Lists are comma-separated strings while editing. */
export interface WorkerSettingsFormState {
  maxConcurrency: string;
  labels: string;
  providers: string;
  profileAlias: string;
  allowedProjects: string[];
  deniedProjects: string[];
  drain: boolean;
}

export const splitCsv = (text: string): string[] => [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];

/** Start the form from what the operator set, falling back to what the worker reports now. */
export function formFromWorker(
  desired: WorkerSettings | undefined,
  current: { maxConcurrency: number; labels: string[]; providers: string[] },
): WorkerSettingsFormState {
  return {
    maxConcurrency: String(desired?.maxConcurrency ?? current.maxConcurrency),
    labels: (desired?.labels ?? current.labels).join(", "),
    providers: (desired?.providers ?? current.providers).join(", "),
    profileAlias: (desired?.profileAlias ?? []).join(", "),
    allowedProjects: desired?.allowedProjects ?? [],
    deniedProjects: desired?.deniedProjects ?? [],
    drain: desired?.drain === true,
  };
}

/** Form -> the PUT body. Returns an error string instead of settings when the input is invalid. */
export function settingsFromForm(form: WorkerSettingsFormState): { settings: WorkerSettings } | { error: string } {
  const max = Number(form.maxConcurrency);
  if (!Number.isInteger(max) || max < 1 || max > 64) return { error: "Max concurrency must be a whole number from 1 to 64." };
  const aliases = splitCsv(form.profileAlias);
  if (aliases.some((a) => !/^[^=\s]+=[^=\s]+$/.test(a))) return { error: "Profile aliases look like default=anth." };
  return {
    settings: {
      maxConcurrency: max,
      labels: splitCsv(form.labels),
      providers: splitCsv(form.providers),
      profileAlias: aliases,
      allowedProjects: form.allowedProjects,
      deniedProjects: form.deniedProjects,
      drain: form.drain,
    },
  };
}

/** Why a field is read-only, or null when the board may edit it. */
export function pinnedNote(key: WorkerSettingKey, pinned: readonly WorkerSettingKey[]): string | null {
  return pinned.includes(key) ? "Set by a start flag on the worker — restart it without the flag to edit here." : null;
}
