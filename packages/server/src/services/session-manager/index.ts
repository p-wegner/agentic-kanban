import type { UpgradeWebSocket } from "hono/ws";
import { createSessionState } from "./types.js";
import { createWsHandler } from "./ws-handler.js";
import { createBroadcaster } from "./broadcast.js";
import { createSessionLifecycle, type SessionLifecycleDeps } from "./session-lifecycle.js";
import type { SessionManagerOptions } from "./types.js";

export type { StartSessionOptions, SessionManagerOptions } from "./types.js";

function createSessionManager(
  upgradeWebSocket: UpgradeWebSocket,
  options?: SessionManagerOptions,
  lifecycleDeps?: SessionLifecycleDeps,
) {
  const state = createSessionState();
  const { subscribe, unsubscribe, wsRoute } = createWsHandler(state, upgradeWebSocket);
  const broadcast = createBroadcaster(state, options);
  const lifecycle = createSessionLifecycle(state, options, broadcast, lifecycleDeps);

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
