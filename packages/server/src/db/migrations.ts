import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { accessSync } from "node:fs";

export function getMigrationsFolder(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  // In bundled/published mode, migrations are adjacent to the JS file in ./migrations/
  const published = resolve(dir, "./migrations");
  // In dev mode, they're in ../../shared/drizzle from src/ (or dist/)
  const dev = resolve(dir, "../../../shared/drizzle");
  try {
    accessSync(resolve(published, "meta/_journal.json"));
    return published;
  } catch {
    return dev;
  }
}
