// Pure monitor-status derivations for BoardToolbar's Monitor button/badge.

/** Tooltip for the Monitor button, listing active mechanisms in a fixed order. */
export function buildMonitorTitle(
  autoMonitor: boolean,
  butlerEnabled: boolean,
  orchestratorAlive: boolean | undefined,
): string {
  const active: string[] = [];
  if (orchestratorAlive) active.push("Orchestrator loop");
  if (butlerEnabled) active.push("Monitor Butler");
  if (autoMonitor) active.push("Auto-monitor");
  if (active.length === 0) return "Board monitor - click to configure";
  return `Active: ${active.join(", ")} — click for details`;
}

/** Count of active monitor mechanisms (the badge renders only when this is ≥ 2). */
export function countActiveMonitors(
  autoMonitor: boolean,
  butlerEnabled: boolean,
  orchestratorAlive: boolean | undefined,
): number {
  return [orchestratorAlive, butlerEnabled, autoMonitor].filter(Boolean).length;
}
