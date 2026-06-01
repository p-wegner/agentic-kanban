import { startServer } from "./server-start.js";
import { resolveRuntimeServerPort } from "./runtime-port.js";

const port = resolveRuntimeServerPort();

const { app, sessionManager, boardEvents } = await startServer(port);

export default app;
export { sessionManager };
