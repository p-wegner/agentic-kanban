/** Field-level validators shared by the manifest and loop-plan parsers (split out of plugin-manifest.ts). */

/** The manifest file name, at the plugin repo root. */
export const PLUGIN_MANIFEST_FILENAME = "kanban-plugin.json";

/** Where a manifest command runs: the plugin's own checkout or the project repo. */
export type PluginCwd = "plugin" | "repo";


export class PluginManifestError extends Error {
  constructor(message: string) {
    super(`Invalid ${PLUGIN_MANIFEST_FILENAME}: ${message}`);
    this.name = "PluginManifestError";
  }
}

export function fail(message: string): never {
  throw new PluginManifestError(message);
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`"${field}" must be a non-empty string`);
  return value.trim();
}

export function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") fail(`"${field}" must be a string`);
  return value.trim() || undefined;
}

export function optionalEnv(value: unknown, field: string): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) fail(`"${field}" must be an object of string values`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") fail(`"${field}.${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

export function optionalCwd(value: unknown, field: string): PluginCwd | undefined {
  if (value == null) return undefined;
  if (value !== "plugin" && value !== "repo") {
    fail(`"${field}" must be "plugin" or "repo" (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`"${field}" must be an array`);
  return value;
}

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(`"${field}" must be an object`);
  return value as Record<string, unknown>;
}

/**
 * A manifest-relative path must stay relative and inside the tree it is resolved
 * against (plugin root or project root) — reject absolute paths and `..` escapes
 * at parse time so no consumer has to re-check.
 */
export function requireRelativePath(value: unknown, field: string): string {
  const text = requireString(value, field).replace(/\\/g, "/");
  if (/^([a-zA-Z]:)?\//.test(text)) fail(`"${field}" must be a relative path (got "${text}")`);
  const segments = text.split("/");
  if (segments.includes("..")) fail(`"${field}" must not contain ".." (got "${text}")`);
  // A trailing slash is not cosmetic: consumers derive a skill's NAME from the dir's basename, and
  // ".claude/skills/x/" yielded an empty name at one site and "x" at another — a skill that shows
  // up in the butler roster and cannot be launched. Reject it where it is cheapest to explain.
  if (text.endsWith("/")) fail(`"${field}" must not end with a slash (got "${text}")`);
  return text;
}
