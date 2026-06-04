import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DRIZZLE_CRITICAL_FILES = [
  "alias.js",
  "errors.js",
  join("libsql", "index.js"),
];

/**
 * Finds drizzle-orm virtual-store directories under node_modules/.pnpm.
 * Returns the first match (there should only be one version installed).
 */
export function findDrizzlePnpmDirs(rootDir) {
  const pnpmDir = join(rootDir, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return [];
  try {
    return readdirSync(pnpmDir)
      .filter((name) => name.startsWith("drizzle-orm@"))
      .map((name) => join(pnpmDir, name, "node_modules", "drizzle-orm"));
  } catch {
    return [];
  }
}

/**
 * Pure function — checks whether the critical drizzle-orm files are present.
 * Returns the list of missing file paths (empty = healthy).
 */
export function checkDrizzleFiles(rootDir) {
  const drizzleDirs = findDrizzlePnpmDirs(rootDir);
  if (drizzleDirs.length === 0) return [];

  const missing = [];
  for (const drizzleDir of drizzleDirs) {
    for (const rel of DRIZZLE_CRITICAL_FILES) {
      const full = join(drizzleDir, rel);
      if (!existsSync(full)) missing.push(full);
    }
  }
  return missing;
}

/**
 * Runs the preflight check and, if files are missing, removes the affected
 * virtual-store dirs and reruns pnpm install before returning.
 * Returns true if a repair was performed (caller should do a clean restart if needed).
 */
export function repairDrizzleIfNeeded(rootDir) {
  const missing = checkDrizzleFiles(rootDir);
  if (missing.length === 0) return false;

  console.warn(
    `[dev] drizzle-orm preflight: ${missing.length} critical file(s) missing — auto-repairing...`,
  );
  for (const p of missing) {
    console.warn(`[dev]   missing: ${p}`);
  }

  const drizzleDirs = findDrizzlePnpmDirs(rootDir);
  for (const drizzleDir of drizzleDirs) {
    // Remove 4 levels up: .pnpm/<drizzle-orm@version>/node_modules/drizzle-orm → .pnpm/<drizzle-orm@version>
    const versionDir = join(drizzleDir, "..", "..");
    console.warn(`[dev] Removing: ${versionDir}`);
    try {
      rmSync(versionDir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[dev] Failed to remove ${versionDir}: ${err.message}`);
    }
  }

  console.warn("[dev] Running pnpm install to re-hardlink drizzle-orm...");
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });

  if (result.status === 0) {
    console.warn("[dev] drizzle-orm repair complete — continuing startup.");
  } else {
    console.error(
      `[dev] pnpm install failed (exit ${result.status ?? result.signal ?? "unknown"}). ` +
        "Run `pnpm install --frozen-lockfile` manually then restart.",
    );
  }

  return true;
}
