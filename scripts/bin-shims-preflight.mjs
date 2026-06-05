import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Shim specs: base name + which package subdirectory contains the .bin folder.
// NOTE: only check the PACKAGE-LOCAL shims the dev servers actually invoke. `tsx` and `vite`
// are dependencies of packages/server and packages/client respectively, NOT of the workspace
// root, so pnpm never creates a root-level node_modules/.bin/tsx in this layout. Checking for
// it made the preflight fail on every start (and `pnpm install --force` can't create a shim for
// a non-dependency), which blocked `pnpm dev` entirely. (regression from the bin-shim ticket)
const SHIM_SPECS = [
  { segments: ["packages", "server", "node_modules", ".bin"], name: "tsx", label: "packages/server/node_modules/.bin/tsx" },
  { segments: ["packages", "client", "node_modules", ".bin"], name: "vite", label: "packages/client/node_modules/.bin/vite" },
];

function shimExists(rootDir, segments, name, win) {
  const cmdPath = join(rootDir, ...segments, `${name}.cmd`);
  const plainPath = join(rootDir, ...segments, name);
  // On Windows pnpm creates a .cmd wrapper; accept either variant so tests
  // can write whichever form they like and the check still passes.
  return win ? existsSync(cmdPath) || existsSync(plainPath) : existsSync(plainPath);
}

/**
 * Pure check — returns a list of {label} objects for every shim that is absent.
 * Empty array means all shims are healthy.
 */
export function checkBinShims(rootDir, { platform = process.platform } = {}) {
  const win = platform === "win32";
  return SHIM_SPECS.filter(({ segments, name }) => !shimExists(rootDir, segments, name, win));
}

/**
 * Runs pnpm install --force and re-checks.
 * Returns true if shims are present after the forced reinstall, false otherwise.
 */
export function repairBinShims(rootDir, {
  runPnpmInstallForce = _defaultRunPnpmInstallForce,
  platform = process.platform,
} = {}) {
  const missing = checkBinShims(rootDir, { platform });
  if (missing.length === 0) return true;

  console.error("");
  console.error("╔══════════════════════════════════════════════════════════════════╗");
  console.error("║  [dev] PREFLIGHT: critical .bin shims are missing                ║");
  console.error("║  plain `pnpm install` silently no-ops for this class of failure. ║");
  console.error("║  Running `pnpm install --force` to relink shims...               ║");
  console.error("╚══════════════════════════════════════════════════════════════════╝");
  console.error("");
  for (const { label } of missing) {
    console.error(`[dev]   missing shim: ${label}`);
  }

  runPnpmInstallForce(rootDir);

  const stillMissing = checkBinShims(rootDir, { platform });
  if (stillMissing.length > 0) {
    console.error("[dev] ERROR: .bin shims still missing after pnpm install --force:");
    for (const { label } of stillMissing) {
      console.error(`[dev]   ${label}`);
    }
    console.error("[dev] Run `pnpm install --force` manually and restart.");
    return false;
  }

  console.warn("[dev] Bin shims restored — continuing startup.");
  return true;
}

/**
 * Full preflight entry point called from dev.mjs.
 * Exits the process with code 1 when shims cannot be restored, so the
 * developer sees a clear error instead of a cryptic "tsx is not recognized".
 */
export function binShimsPreflight(rootDir, {
  runPnpmInstallForce = _defaultRunPnpmInstallForce,
  platform = process.platform,
} = {}) {
  const missing = checkBinShims(rootDir, { platform });
  if (missing.length === 0) return;

  const ok = repairBinShims(rootDir, { runPnpmInstallForce, platform });
  if (!ok) {
    process.exit(1);
  }
}

function _defaultRunPnpmInstallForce(rootDir) {
  const result = spawnSync("pnpm", ["install", "--force"], {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(
      `[dev] pnpm install --force failed (exit ${result.status ?? result.signal ?? "unknown"}). ` +
        "Run `pnpm install --force` manually then restart.",
    );
  }
}
