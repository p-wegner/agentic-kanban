import { cpSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const serverDist = resolve(root, "packages/server/dist");
const clientDist = resolve(root, "packages/client/dist");
const sharedDrizzle = resolve(root, "packages/shared/drizzle");

// Ensure server dist exists
mkdirSync(serverDist, { recursive: true });

// Copy client build output to server/dist/client/
try {
  cpSync(clientDist, resolve(serverDist, "client"), { recursive: true });
  console.log("Copied: client/dist → server/dist/client/");
} catch (err) {
  console.warn("Warning: Could not copy client assets (client may not be built yet):", err.message);
}

// Copy migrations to server/dist/migrations/
try {
  cpSync(sharedDrizzle, resolve(serverDist, "migrations"), { recursive: true });
  console.log("Copied: shared/drizzle → server/dist/migrations/");
} catch (err) {
  console.warn("Warning: Could not copy migrations:", err.message);
}
