import { useCallback, useEffect, useRef } from "react";
import type { DeliveryStatusResponse } from "@agentic-kanban/shared/types";
import { startStaggeredPoll } from "../lib/pollScheduler.js";
import { useApiResource } from "./useApiResource.js";

/** The header Delivery chip's data (#1155), mirroring `useAutopilot`. */
export interface DeliveryController {
  status: DeliveryStatusResponse | null;
  error: string | null;
  /** Re-read now — after the Delivery panel writes a preference. */
  refresh: () => Promise<void>;
}

const BOARD_CHANGE_DEBOUNCE_MS = 750;
const POLL_MS = 30_000;

/**
 * Reads `GET /api/projects/:id/delivery` for the active project: on project switch, shortly
 * after every board change (`refreshKey`), and on a slow visibility-gated poll — same shape as
 * `useAutopilot`, which this chip sits beside in the header.
 */
export function useDeliveryStatus(projectId: string | null, refreshKey?: unknown): DeliveryController {
  const resource = useApiResource<DeliveryStatusResponse>(
    projectId ? `/api/projects/${projectId}/delivery` : null,
    { fallbackError: "Failed to load delivery status" },
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

  const status = resource.data && resource.data.projectId === projectId ? resource.data : null;
  return { status, error: resource.error, refresh };
}
