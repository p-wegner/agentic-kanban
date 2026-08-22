/**
 * The codec for a workflow node's `config` column (#722).
 *
 * A workflow-template node stores every per-node setting the builder exposes — join
 * strategy, guidance text, fork mode, fork fan-out, and the per-node agent override — as
 * ONE nullable JSON string. So every setting is a read/write pair over the same document,
 * each pair must preserve the keys it does not own, and an unparseable or absent document
 * must degrade to the field's default rather than throw at a `<select>`. That shared
 * parse/serialize contract is what makes these functions one module: they are the accessors
 * of a single value, not a bag of helpers.
 *
 * Invariant kept by every writer here: a document that ends up empty serializes back to
 * `null`, so clearing the last setting leaves no `"{}"` behind in the database.
 */

/** Agent harnesses a node may pin its board-launched sessions to. */
export const AGENT_PROVIDERS = ["claude", "codex", "copilot", "pi"] as const;

/** Parse a node's config document; anything unparseable reads as empty. */
function parseConfig(config: string | null): Record<string, unknown> {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Serialize a config document back, collapsing an empty one to `null`. */
function serializeConfig(obj: Record<string, unknown>): string | null {
  return Object.keys(obj).length ? JSON.stringify(obj) : null;
}

/** Read the join strategy from a node's JSON config (defaults to "artifacts"). */
export function readJoinStrategy(config: string | null): string {
  return (parseConfig(config) as { joinStrategy?: string }).joinStrategy === "merge" ? "merge" : "artifacts";
}

/** Write the join strategy into a node's JSON config, preserving other keys. */
export function writeJoinStrategy(config: string | null, strategy: string): string | null {
  const obj = parseConfig(config);
  if (strategy === "merge") obj.joinStrategy = "merge";
  else delete obj.joinStrategy;
  return serializeConfig(obj);
}

/** Read the guidance string from a node's JSON config (defaults to ""). */
export function readGuidance(config: string | null): string {
  return (parseConfig(config) as { guidance?: string }).guidance ?? "";
}

/** Write the guidance string into a node's JSON config, preserving other keys. */
export function writeGuidance(config: string | null, value: string): string | null {
  const obj = parseConfig(config);
  if (value) obj.guidance = value;
  else delete obj.guidance;
  return serializeConfig(obj);
}

/** Read the fork mode from a node's JSON config (defaults to "worktree"). */
export function readForkMode(config: string | null): string {
  return (parseConfig(config) as { forkMode?: string }).forkMode === "shared" ? "shared" : "worktree";
}

/** Write the fork mode into a node's JSON config, preserving other keys. */
export function writeForkMode(config: string | null, mode: string): string | null {
  const obj = parseConfig(config);
  if (mode === "shared") obj.forkMode = "shared";
  else delete obj.forkMode;
  return serializeConfig(obj);
}

/** Read the fork's maxParallel from its JSON config ("" = use the global default). */
export function readForkMaxParallel(config: string | null): string {
  const value = (parseConfig(config) as { maxParallel?: unknown }).maxParallel;
  return typeof value === "number" && value >= 1 ? String(value) : "";
}

/** Write the fork's maxParallel into its JSON config, preserving other keys. */
export function writeForkMaxParallel(config: string | null, raw: string): string | null {
  const obj = parseConfig(config);
  const n = Math.floor(Number(raw));
  if (Number.isFinite(n) && n >= 1) obj.maxParallel = n;
  else delete obj.maxParallel;
  return serializeConfig(obj);
}

/** One field of the per-node agent override. */
export type AgentOverrideField = "provider" | "profile" | "model";

/** Read one field of the node's `agent` override from its JSON config (defaults to ""). */
export function readAgentField(config: string | null, field: AgentOverrideField): string {
  const agent = (parseConfig(config) as { agent?: Record<string, unknown> }).agent;
  const value = agent?.[field];
  return typeof value === "string" ? value : "";
}

/** Write one field of the node's `agent` override into its JSON config, preserving other keys. */
export function writeAgentField(config: string | null, field: AgentOverrideField, value: string): string | null {
  const obj = parseConfig(config);
  const agent = typeof obj.agent === "object" && obj.agent !== null ? { ...(obj.agent as Record<string, unknown>) } : {};
  if (value) agent[field] = value;
  else delete agent[field];
  if (Object.keys(agent).length) obj.agent = agent;
  else delete obj.agent;
  return serializeConfig(obj);
}
