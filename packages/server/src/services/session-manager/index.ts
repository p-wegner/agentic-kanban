import { createSessionState } from "./types.js";
import { createWsHandler } from "./ws-handler.js";
import { createBroadcaster } from "./broadcast.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

export type { StartSessionOptions, SessionManagerOptions } from "./types.js";

function createSessionManager(
  upgradeWebSocket: (callback: (c: any) => any) => any,
  options?: SessionManagerOptions,
) {
  const state = createSessionState();
  const { subscribe, unsubscribe, wsRoute } = createWsHandler(state, upgradeWebSocket);
  const broadcast = createBroadcaster(state, options);
  const lifecycle = createSessionLifecycle(state, options, broadcast);

  return {
    ...lifecycle,
    subscribe,
    unsubscribe,
    wsRoute,
    handleOutput: broadcast,
  };
}

export { createSessionManager };
export type SessionManager = ReturnType<typeof createSessionManager>;
