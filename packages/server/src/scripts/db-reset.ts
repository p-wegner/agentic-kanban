import { unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(__dirname, "../../../kanban.db");

try {
  unlinkSync(dbPath);
  console.log("Deleted kanban.db");
} catch (e: any) {
  if (e.code === "ENOENT") {
    console.log("No DB file to delete");
  } else if (e.code === "EBUSY") {
    console.error("Error: kanban.db is locked. Stop the dev server first.");
    process.exit(1);
  } else {
    throw e;
  }
}
