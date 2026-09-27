import { useCallback, useEffect, useRef } from "react";
import type { DeliveryStatusResponse } from "@agentic-kanban/shared/types";
import type { ClientRefreshReason } from "@agentic-kanban/shared/lib/board-events-contract";
import { startStaggeredPoll } from "../lib/pollScheduler.js";
import { useApiResource } from "./useApiResource.js";
import { useBoardWsRefresh } from "./useBoardWsRefresh.js";

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
 * Board events that move the chip's live merge state: a train row changing state (created,
 * gating, a bisect node, landed/red/abandoned), the train window, and a branch joining or
 * leaving the ready queue. The server already broadcasts all of them, so the chip follows a
 * train within the debounce instead of waiting for the 30 s poll.
 */
export const DELIVERY_REFRESH_REASONS: ReadonlySet<ClientRefreshReason> = new Set<ClientRefreshReason>([
  "merge_train_changed",
  "merge_train_window_changed",
  "workspace_ready_for_merge",
  "workspace_merged",
  "workspace_closed",
  "reconnect",
]);

/**
 * Reads `GET /api/projects/:id/delivery` for the active project: on project switch, shortly
 * after a merge-relevant board WebSocket event (`DELIVERY_REFRESH_REASONS`) or a `refreshKey`
 * change, and on a slow visibility-gated poll — same shape as
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

  useBoardWsRefresh({
    projectId,
    shouldRefetch: (reason) => DELIVERY_REFRESH_REASONS.has(reason),
    refresh: reload,
    debounceMs: BOARD_CHANGE_DEBOUNCE_MS,
  });

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
