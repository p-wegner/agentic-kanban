import { startServer } from "./server-start.js";

const port = Number(process.env.PORT) || 3001;

const { app, sessionManager, boardEvents } = await startServer(port);

export default app;
export { sessionManager };
