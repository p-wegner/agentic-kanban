import { cpSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
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

// Copy the scaffold hook sources to server/dist/scaffold/hooks/ so npm/npx installs can
// scaffold them into registered projects (resolveHookSource reads this dir first — #952).
// Canonical source for the verify-gate runner is the TESTED copy in src/scaffold/; the
// remaining generic hooks are canonical in the repo's .claude/hooks/.
// Missing sources are a BUG (broken publish would silently drop the quality gate) — fail loud.
const scaffoldHookSources = [
  resolve(root, "packages/server/src/scaffold/verify-gate-runner.js"),
  resolve(root, ".claude/hooks/vital-file-guard.js"),
  resolve(root, ".claude/hooks/prevent-cross-worktree-writes.js"),
  resolve(root, ".claude/hooks/smart-hooks-runner.js"),
];
const scaffoldHooksDist = resolve(serverDist, "scaffold/hooks");
mkdirSync(scaffoldHooksDist, { recursive: true });
for (const src of scaffoldHookSources) {
  if (!existsSync(src)) {
    console.error(`ERROR: scaffold hook source missing: ${src} — the published package would silently skip this hook (#952)`);
    process.exit(1);
  }
  copyFileSync(src, resolve(scaffoldHooksDist, basename(src)));
}
console.log(`Copied: ${scaffoldHookSources.length} scaffold hook sources → server/dist/scaffold/hooks/`);
