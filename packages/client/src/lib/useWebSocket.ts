import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { apiFetch } from "./api.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

type ConnectionState = "connecting" | "open" | "closed" | "error";

export function useWebSocket(sessionId: string | null) {
  const [state, setState] = useState<ConnectionState>("closed");
  const [messages, setMessages] = useState<AgentOutputMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (!sessionId) return;

    setMessages([]);

    // Load historical output first, then connect WS for live updates
    apiFetch<AgentOutputMessage[]>(`/api/sessions/${sessionId}/output`)
      .then((history) => {
        setMessages(history);
      })
      .catch(() => {
        // Session may be new with no output yet
      });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/sessions/${sessionId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setState("open");
    };

    ws.onmessage = (event) => {
      try {
        const msg: AgentOutputMessage = JSON.parse(event.data);
        setMessages((prev) => [...prev, msg]);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setState("closed");
    };

    ws.onerror = () => {
      setState("error");
    };

    setState("connecting");
  }, [sessionId]);

  useEffect(() => {
    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // Detect when agent has finished a turn and is waiting for input
  const isWaitingForInput = useMemo(() => {
    if (state !== "open") return false;
    // Scan messages backwards for a result event
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "exit") return false;
      if (msg.type === "stdout" && msg.data) {
        try {
          const obj = JSON.parse(msg.data);
          if (obj.type === "result") return true;
        } catch { /* not JSON */ }
      }
    }
    return false;
  }, [messages, state]);

  return { state, messages, connect, disconnect, isWaitingForInput };
}
