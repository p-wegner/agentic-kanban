import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate (arch-review #873): the correctness-critical external runtime
 * dependencies must be pinned to EXACT versions, and the root manifest must declare
 * an `engines.node` constraint.
 *
 * Rationale: these packages are pre-1.0 / early (DB driver, MCP wire protocol, the
 * agent SDK) where a minor bump can break behaviour. A caret/tilde range lets an
 * unattended `pnpm install` silently float onto a breaking version. Pinning forces
 * every upgrade to be a deliberate, reviewable manifest change that goes through the
 * check suite — instead of drifting in via the lockfile.
 *
 * To upgrade one of these deps: bump the exact version here AND in the lockfile in
 * the same commit, run `pnpm check`, and review the diff.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/**
 * Deps that must be pinned to an exact version wherever they appear (in any package,
 * dependencies or devDependencies). These are the silent-breakage-risk packages the
 * arch review flagged.
 */
const MUST_BE_EXACT = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@libsql/client",
  "@modelcontextprotocol/sdk",
  "drizzle-orm",
  "drizzle-kit",
]);

/** Manifests to scan. Relative to REPO_ROOT. */
const MANIFESTS = [
  "package.json",
  join("packages", "shared", "package.json"),
  join("packages", "server", "package.json"),
  join("packages", "mcp-server", "package.json"),
  join("packages", "client", "package.json"),
  join("packages", "desktop", "package.json"),
  join("packages", "e2e", "package.json"),
];

/** An exact version: a bare semver with no range operator (no ^ ~ >= < x * || -). */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
};

function readManifest(rel: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")) as Manifest;
}

describe("dependency pinning gate (#873)", () => {
  it("correctness-critical deps are pinned to exact versions everywhere", () => {
    const offenders: string[] = [];
    for (const rel of MANIFESTS) {
      const manifest = readManifest(rel);
      for (const block of ["dependencies", "devDependencies"] as const) {
        const deps = manifest[block];
        if (!deps) continue;
        for (const [name, spec] of Object.entries(deps)) {
          if (!MUST_BE_EXACT.has(name)) continue;
          if (!EXACT_VERSION.test(spec)) {
            offenders.push(`${rel} → ${block}.${name}: "${spec}" is not an exact version`);
          }
        }
      }
    }

    expect(
      offenders,
      `These correctness-critical deps must be pinned to an exact version ` +
        `(no caret/tilde/range) — see packages/shared/__tests__/dependency-pinning.test.ts:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("the root manifest declares an engines.node constraint", () => {
    const root = readManifest("package.json");
    expect(root.engines?.node, "root package.json must declare engines.node").toBeTruthy();
  });
});
