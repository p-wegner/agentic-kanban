import type { ServiceStackConfig } from "@agentic-kanban/shared";

/**
 * The services slice of the Settings panel's project form state.
 *
 * The panel only has inputs for enabled/composeFile/composeRepo/ports, but the
 * server-side `ServiceStackConfig` contract also accepts API-only fields
 * (`env`, `readyTimeoutMs`). `servicesConfigBase` keeps the full last-fetched
 * config so a settings save can round-trip those fields instead of silently
 * wiping them (finding #19).
 */
export type ServicesConfigFormFields = {
  servicesEnabled: boolean;
  servicesComposeFile: string;
  servicesComposeRepo: string;
  /** comma-separated port names as typed in the form */
  servicesPorts: string;
  /** Full config as last fetched from the server; null when the project has none. */
  servicesConfigBase: ServiceStackConfig | null;
};

/**
 * Build the servicesConfig PATCH payload from the panel's flat form fields
 * (or null to clear the stack config entirely).
 *
 * Form fields are merged OVER `servicesConfigBase`, so every field the server
 * accepts but the form does not model (env, readyTimeoutMs, future additions)
 * survives an unrelated settings save untouched.
 */
export function buildServicesConfig(s: ServicesConfigFormFields): ServiceStackConfig | null {
  const composeFile = s.servicesComposeFile.trim();
  const composeRepo = s.servicesComposeRepo.trim();
  const ports = s.servicesPorts.split(",").map((p) => p.trim()).filter(Boolean);
  // Nothing configured and disabled → clear the stack entirely.
  if (!s.servicesEnabled && !composeFile && !composeRepo && ports.length === 0) return null;
  const cfg: ServiceStackConfig = {
    ...(s.servicesConfigBase ?? {}),
    enabled: s.servicesEnabled,
    composeFile: composeFile || "docker-compose.yml",
    ports,
  };
  // composeRepo has a form input, so an emptied field means "back to the leading repo" —
  // drop any value inherited from the base instead of resurrecting it.
  if (composeRepo) cfg.composeRepo = composeRepo;
  else delete cfg.composeRepo;
  return cfg;
}
