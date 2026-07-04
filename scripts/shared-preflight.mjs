import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnSyncPnpm } from "./pnpm-exec.mjs";

/**
 * Checks whether packages/shared appears wiped or incomplete by looking for
 * the two most reliable indicators: the package.json manifest and at least one
 * migration SQL file in the drizzle directory.
 *
 * Returns an object describing what is missing (empty arrays = healthy).
 */
export function checkSharedPackage(rootDir) {
  const sharedDir = join(rootDir, "packages", "shared");
  const pkgJson = join(sharedDir, "package.json");
  const drizzleDir = join(sharedDir, "drizzle");

  const missingFiles = [];
  let drizzleEmpty = false;

  if (!existsSync(pkgJson)) {
    missingFiles.push(pkgJson);
  }

  if (!existsSync(drizzleDir)) {
    drizzleEmpty = true;
  } else {
    try {
      const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
      if (sqlFiles.length === 0) drizzleEmpty = true;
    } catch {
      drizzleEmpty = true;
    }
  }

  return { missingFiles, drizzleEmpty };
}

/**
 * Checks whether node_modules/.bin/tsx (or the server-local tsx) is present.
 */
export function isTsxMissing(rootDir) {
  const rootBin = join(rootDir, "node_modules", ".bin", "tsx");
  const serverBin = join(rootDir, "packages", "server", "node_modules", ".bin", "tsx");
  return !existsSync(rootBin) && !existsSync(serverBin);
}

/**
 * Runs the full shared-package preflight.
 * - If packages/shared looks wiped: restores via `git restore packages/shared`
 *   and logs a loud warning naming the recurring deletion class.
 * - After restore, if tsx is still missing: runs `pnpm install --force`.
 * - No-op when the tree is healthy.
 * - Never touches files outside packages/shared.
 *
 * Accepts optional injected side-effectful operations for unit testing.
 */
export function repairSharedIfNeeded(rootDir, {
  runGitRestore = _defaultRunGitRestore,
  runPnpmInstallForce = _defaultRunPnpmInstallForce,
} = {}) {
  const { missingFiles, drizzleEmpty } = checkSharedPackage(rootDir);
  const needsRestore = missingFiles.length > 0 || drizzleEmpty;

  if (!needsRestore) return false;

  // ─── LOUD WARNING ────────────────────────────────────────────────────────
  console.error("");
  console.error("╔══════════════════════════════════════════════════════════════════╗");
  console.error("║  [dev] FATAL PREFLIGHT: packages/shared has been WIPED           ║");
  console.error("║  This is the recurring 'mystery file deletion' failure class.    ║");
  console.error("║  Auto-restoring from git HEAD before launching...                ║");
  console.error("╚══════════════════════════════════════════════════════════════════╝");
  console.error("");

  if (missingFiles.length > 0) {
    for (const f of missingFiles) {
      console.error(`[dev]   missing: ${f}`);
    }
  }
  if (drizzleEmpty) {
    console.error(`[dev]   packages/shared/drizzle/ is missing or empty`);
  }

  const restored = runGitRestore(rootDir);
  if (!restored) {
    console.error("[dev] git restore failed — server may not start correctly.");
    return true;
  }

  console.warn("[dev] packages/shared restored from git HEAD.");

  if (isTsxMissing(rootDir)) {
    console.warn("[dev] node_modules/.bin/tsx still missing — running pnpm install --force...");
    runPnpmInstallForce(rootDir);
  }

  return true;
}

function _defaultRunGitRestore(rootDir) {
  const result = spawnSync("git", ["restore", "packages/shared"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  return result.status === 0;
}

function _defaultRunPnpmInstallForce(rootDir) {
  const result = spawnSyncPnpm(["install", "--force"], {
    cwd: rootDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(
      `[dev] pnpm install --force failed (exit ${result.status ?? result.signal ?? "unknown"}). ` +
        "Run `pnpm install --force` manually then restart.",
    );
  } else {
    console.warn("[dev] pnpm install --force complete — continuing startup.");
  }
}
