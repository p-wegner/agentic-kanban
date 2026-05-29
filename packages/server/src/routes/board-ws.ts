import type { BoardEvents } from "../services/board-events.js";

/**
 * Creates the WebSocket route handler for real-time board events.
 *
 * Extracted from the board-events service so that HTTP/WebSocket routing
 * concerns live in the routes layer rather than in the event service.
 *
 * Usage:
 *   app.get("/ws/board/:projectId", createBoardWsRoute(upgradeWebSocket, boardEvents));
 */
export function createBoardWsRoute(
  upgradeWebSocket: (callback: (c: any) => any) => any,
  boardEvents: BoardEvents,
) {
  return upgradeWebSocket((c: any) => {
    const projectId = c.req.param("projectId");
    return {
      onOpen(_event: any, ws: any) {
        boardEvents.subscribe(projectId, ws);
      },
      onClose(_event: any, ws: any) {
        boardEvents.unsubscribe(projectId, ws);
      },
    };
  });
}
