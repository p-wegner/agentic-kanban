import { workerAllowsProject } from "@agentic-kanban/shared/lib/worker-settings";
import type { WorkerFleet } from "./worker-fleet.service.js";

/**
 * #1381: the fleet as ONE project sees it — workers whose board-side allowed/denied project
 * lists bar the project are not there at all, so every selection, capacity count and strict
 * readiness check made through it enforces the lists without each having to know about them.
 */
export function fleetForProject(fleet: WorkerFleet, projectId: string): WorkerFleet {
  return {
    ...fleet,
    registry: {
      ...fleet.registry,
      listWorkersView: async (now?: string) =>
        (await fleet.registry.listWorkersView(now)).filter(
          (w) => workerAllowsProject(w.desiredSettings?.settings, projectId).allowed,
        ),
    },
  };
}
