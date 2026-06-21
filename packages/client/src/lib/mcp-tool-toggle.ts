// Pure marshalling for the MCP "disabled tools" setting, stored as a comma-joined
// string. Extracted from SettingsPanel so the empty-CSV round-trip (a Set that
// re-joins to "" rather than undefined) is unit-tested; the component keeps the
// thin setSettings wrappers.

/** Parse the comma-joined `disabled_mcp_tools` string into a Set (drops empties). */
export function parseDisabledTools(csv: string | undefined): Set<string> {
  return new Set((csv || "").split(",").filter(Boolean));
}

/** Whether `name` is in the disabled set. */
export function isToolDisabled(disabled: ReadonlySet<string>, name: string): boolean {
  return disabled.has(name);
}

/** The next comma-joined CSV after toggling `name` on/off (empty set → ""). */
export function withToolDisabled(disabled: ReadonlySet<string>, name: string, isDisabled: boolean): string {
  const next = new Set(disabled);
  if (isDisabled) next.add(name);
  else next.delete(name);
  return [...next].join(",");
}
