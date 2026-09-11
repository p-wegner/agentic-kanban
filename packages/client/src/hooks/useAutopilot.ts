import { useCallback, useEffect, useRef } from "react";
import type { AutopilotStatusResponse } from "@agentic-kanban/shared/types";
import { startStaggeredPoll } from "../lib/pollScheduler.js";
import { useApiResource } from "./useApiResource.js";

/** The toolbar Autopilot chip's data (#1102), shared with the run-queue forecast. */
export interface AutopilotController {
  status: AutopilotStatusResponse | null;
  error: string | null;
  /** Re-read now — after a chip control writes a preference. */
  refresh: () => Promise<void>;
}

/** How long after a board change the chip re-reads, so a burst of events costs one request. */
const BOARD_CHANGE_DEBOUNCE_MS = 750;
const POLL_MS = 30_000;

/**
 * Reads `GET /api/projects/:id/autopilot` for the active project (through `useApiResource`, the
 * one data/loading/error ladder): on project switch, shortly after every board change
 * (`refreshKey` — the board's columns, re-fetched on each board event), and on a slow
 * visibility-gated poll so a cycle that started work while the board was quiet still shows up.
 */
export function useAutopilot(projectId: string | null, refreshKey?: unknown): AutopilotController {
  const resource = useApiResource<AutopilotStatusResponse>(
    projectId ? `/api/projects/${projectId}/autopilot` : null,
    { fallbackError: "Failed to load autopilot status" },
  );
  const { reload } = resource;

  useEffect(() => {
    if (!projectId) return;
    const poll = startStaggeredPoll(reload, POLL_MS);
    return () => poll.stop();
  }, [projectId, reload]);

  const lastKeyRef = useRef(refreshKey);
  useEffect(() => {
    if (lastKeyRef.current === refreshKey) return;
    lastKeyRef.current = refreshKey;
    if (!projectId) return;
    const timer = setTimeout(reload, BOARD_CHANGE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [refreshKey, projectId, reload]);

  const refresh = useCallback(async () => { reload(); }, [reload]);

  // `useApiResource` keeps the previous answer while the next one loads; never paint another
  // project's numbers on this one's chip after a switch.
  const status = resource.data && resource.data.projectId === projectId ? resource.data : null;
  return { status, error: resource.error, refresh };
}
