import { unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Delete all known DB locations (server + mcp-server + repo root)
const dbPaths = [
  resolve(__dirname, "../../kanban.db"),          // packages/server/kanban.db (primary)
  resolve(__dirname, "../../../mcp-server/kanban.db"), // packages/mcp-server/kanban.db
  resolve(__dirname, "../../../kanban.db"),        // repo root (legacy location)
];

for (const dbPath of dbPaths) {
  try {
    unlinkSync(dbPath);
    console.log(`Deleted ${dbPath}`);
  } catch (e: any) {
    if (e.code === "ENOENT") {
      // File doesn't exist — skip
    } else if (e.code === "EBUSY") {
      console.error(`Error: ${dbPath} is locked. Stop the dev server first.`);
      process.exit(1);
    } else {
      throw e;
    }
  }
}
