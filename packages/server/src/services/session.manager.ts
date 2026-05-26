export { createSessionManager } from "./session-manager/index.js";
export type { StartSessionOptions } from "./session-manager/types.js";
import type { createSessionManager } from "./session-manager/index.js";
export type SessionManager = ReturnType<typeof createSessionManager>;
