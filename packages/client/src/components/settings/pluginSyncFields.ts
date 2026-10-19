export type SyncFieldType = "text" | "boolean" | "number" | "json";

/** Error text for a field value that cannot be saved, or null. Empty is always valid (required is the server's check). */
export function validateSyncField(type: SyncFieldType, value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (type === "number") {
    return /^\d+$/.test(v) ? null : "must be a whole number (0 or more)";
  }
  if (type === "boolean") {
    return v === "true" || v === "false" ? null : "must be true or false";
  }
  if (type === "json") {
    try {
      const parsed: unknown = JSON.parse(v);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? null : "must be a JSON object";
    } catch (err) {
      return `invalid JSON: ${err instanceof Error ? err.message : "parse error"}`;
    }
  }
  return null;
}

/** First error per field key across the form, for the Save guard. */
export function validateSyncFields(
  fields: Array<{ key: string; type: SyncFieldType }>,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const message = validateSyncField(f.type, values[f.key] ?? "");
    if (message) errors[f.key] = message;
  }
  return errors;
}
