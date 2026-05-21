import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { apiFetch } from "./api.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";

type ConnectionState = "connecting" | "open" | "closed" | "error";

export function useWebSocket(sessionId: string | null) {
  const [state, setState] = useState<ConnectionState>("closed");
  const [messages, setMessages] = useState<AgentOutputMessage[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const unmountedRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  // Track highest message ID seen so reconnect fetches only new messages
  const lastMessageCountRef = useRef(0);

  const connect = useCallback(() => {
    if (!sessionId || unmountedRef.current) return;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }

    const isReconnect = lastMessageCountRef.current > 0;

    if (!isReconnect) {
      setMessages([]);
      lastMessageCountRef.current = 0;
    }

    // Load historical output first, then connect WS for live updates
    apiFetch<AgentOutputMessage[]>(`/api/sessions/${sessionId}/output`)
      .then((history) => {
        setMessages(history);
        lastMessageCountRef.current = history.length;
      })
      .catch(() => {
        // Session may be new with no output yet
      });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/sessions/${sessionId}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayRef.current = 1000;
      setState("open");
    };

    ws.onmessage = (event) => {
      try {
        const msg: AgentOutputMessage = JSON.parse(event.data);
        setMessages((prev) => {
          lastMessageCountRef.current = prev.length + 1;
          return [...prev, msg];
        });
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setState("closed");
      if (unmountedRef.current) return;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, 30_000);
      reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
    };

    ws.onerror = () => {
      // Error will be followed by onclose — reconnect handles it
      setState("error");
    };

    setState("connecting");
  }, [sessionId]);

  connectRef.current = connect;

  useEffect(() => {
    unmountedRef.current = false;
    reconnectDelayRef.current = 1000;
    lastMessageCountRef.current = 0;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const disconnect = useCallback(() => {
    unmountedRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
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
