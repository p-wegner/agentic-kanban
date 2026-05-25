import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localDbDir = resolve(__dirname, "../../");

export const DATA_DIR = process.env.AGENTIC_KANBAN_DIR
  || (existsSync(resolve(localDbDir, "kanban.db")) ? localDbDir : join(homedir(), ".agentic-kanban"));

export function getDbUrl(): string {
  if (process.env.DB_URL) return process.env.DB_URL;
  return `file:${resolve(DATA_DIR, "kanban.db")}`;
}

export function ensureDataDir(): string {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  return DATA_DIR;
}

export function dbExists(): boolean {
  const url = getDbUrl();
  if (!url.startsWith("file:")) return false;
  const path = url.slice("file:".length);
  return existsSync(path);
}
