import { useMemo } from "react";
import { buildRunQueueForecast } from "../lib/runQueueForecast.js";
import { useAutopilot, type AutopilotController } from "./useAutopilot.js";

type ForecastColumns = Parameters<typeof buildRunQueueForecast>[0];

export interface AutopilotForecast {
  autopilot: AutopilotController;
  runQueueForecast: ReturnType<typeof buildRunQueueForecast>;
}

/**
 * The Autopilot chip's read and the run-queue forecast are ONE concern (#1102): both answer
 * "how many agents may run for this project", and the forecast must use the same limit the chip
 * shows or the board states two different numbers. `activeAgentsTarget` (the sprint-capacity
 * policy) is the fallback until the autopilot read lands, and 5 is the resolver's own default.
 */
export function useAutopilotForecast(
  projectId: string | null,
  columns: ForecastColumns,
  activeAgentsTarget: number | null | undefined,
): AutopilotForecast {
  const autopilot = useAutopilot(projectId, columns);
  const target = autopilot.status?.limit ?? activeAgentsTarget ?? 5;
  const runQueueForecast = useMemo(() => buildRunQueueForecast(columns, target), [columns, target]);
  return { autopilot, runQueueForecast };
}
