import { E2E_CLIENT_PORT, E2E_SERVER_PORT } from "../../ports.js";

// #645: these used to carry their OWN `|| 3001` / `|| 5173` defaults, independent of the
// Playwright config's. Isolating the config alone would then have started the stack on the
// E2E ports while every spec kept calling the dev board on 3001. One definition now.
export const SERVER_PORT = E2E_SERVER_PORT;
export const CLIENT_PORT = E2E_CLIENT_PORT;
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
export const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
