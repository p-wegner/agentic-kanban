/**
 * Runtime codecs + defaults for the service-stack JSON text columns (#612).
 *
 * These lived in `types/service-stack.ts`, which is a TYPE element — its whole contract is
 * "interfaces only, safe to re-export anywhere". Runtime values there are the same category
 * of mistake as the schema-barrel re-export in #618: it works, nothing flags it, and the
 * element stops meaning what its name says. (#531 added the codecs; #596 was the cost of a
 * value hiding in a module people assume is erased.)
 *
 * Types are imported FROM types/ — never the reverse, so `types/` stays a leaf.
 */
import type { ServiceStackConfig, ServiceStackState } from "../types/service-stack.js";

/** Defaults merged over a partial stored config. Runtime value, hence here not in types/. */
export const DEFAULT_SERVICE_STACK_CONFIG: ServiceStackConfig = {
  enabled: false,
  composeFile: "docker-compose.yml",
  ports: [],
  readyTimeoutMs: 120000,
};


//
// `projects.services_config` and `workspaces.service_state` are plain `text`, so every
// reader hand-parsed them — nine parsers between them, and the two `parseServicesConfig`
// DISAGREED: the wire-DTO one in routes/projects.ts returned whatever parsed, while the
// runtime one required `enabled === true` and merged defaults. A project whose config
// says `enabled: false` therefore appeared on the board as a configured stack that the
// runtime would never start.
//
// Both intents are legitimate, so they are two NAMED functions rather than one function
// with a flag nobody remembers to pass.

/**
 * Normalise a stored `servicesConfig` string, whatever its `enabled` value.
 * Use for DISPLAY — the board shows a project's declared stack even when disabled.
 * Returns null only when the column is empty or corrupt.
 */
export function parseServiceStackConfig(raw: string | null | undefined): ServiceStackConfig | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceStackConfig> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      ...DEFAULT_SERVICE_STACK_CONFIG,
      ...parsed,
      enabled: parsed.enabled === true,
      composeFile: parsed.composeFile?.trim() || DEFAULT_SERVICE_STACK_CONFIG.composeFile,
    };
  } catch {
    // Corrupt stored value: treat as "no stack" rather than crashing a board list.
    return null;
  }
}

/**
 * The stack to actually BRING UP, or null. Same parse, but a disabled stack is null —
 * the runtime must never start one the operator switched off.
 */
export function parseEnabledServiceStackConfig(raw: string | null | undefined): ServiceStackConfig | null {
  const config = parseServiceStackConfig(raw);
  return config?.enabled === true ? config : null;
}

/**
 * Parse a stored `workspaces.service_state` blob into a NORMALISED state, or null when
 * it is absent, unparseable, or structurally invalid (#531).
 *
 * Three readers hand-parsed this at two different strictness levels. The two lenient
 * copies checked only that `composeProjectName` was a string and returned the raw parsed
 * object — so a blob missing `ports` or `envFilePath` reached consumers that index them,
 * and an unknown `status` rendered as a live stack. This codec fills the defaults and
 * rejects an unknown status, which is what the adoption path already required.
 *
 * NOT every reader should use it — see `parseStoredComposeProjectName` and the port scan
 * in `workspace-service-state.repository`, both of which must stay LENIENT on purpose.
 */
export function parseServiceStackState(raw: string | null | undefined): ServiceStackState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceStackState> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (typeof parsed.composeProjectName !== "string") return null;
    if (parsed.status !== "up" && parsed.status !== "error" && parsed.status !== "down") return null;
    return {
      composeProjectName: parsed.composeProjectName,
      ports: parsed.ports && typeof parsed.ports === "object" ? parsed.ports : {},
      envFilePath: typeof parsed.envFilePath === "string" ? parsed.envFilePath : "",
      status: parsed.status,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(parsed.deferred === true ? { deferred: true } : {}),
      ...(Array.isArray(parsed.lintWarnings) && parsed.lintWarnings.every((w) => typeof w === "string")
        ? { lintWarnings: parsed.lintWarnings }
        : {}),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
