import { useEffect, useRef, useCallback } from "react";

interface BoardChangedEvent {
  type: "board_changed";
  projectId: string;
  reason: string;
}

export function useBoardEvents(
  projectId: string | null,
  onBoardChange: (reason: string) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const onBoardChangeRef = useRef(onBoardChange);
  onBoardChangeRef.current = onBoardChange;

  const connect = useCallback(() => {
    if (!projectId) return;

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/board/${projectId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg: BoardChangedEvent = JSON.parse(event.data);
        if (msg.type === "board_changed") {
          onBoardChangeRef.current(msg.reason);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      // Silently ignore — board events are nice-to-have
    };

    return ws;
  }, [projectId]);

  useEffect(() => {
    const ws = connect();

    return () => {
      if (ws) {
        ws.close();
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);
}
