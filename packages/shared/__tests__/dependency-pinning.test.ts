import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Architecture gate (arch-review #873, extended by #900): external runtime
 * dependencies whose silent drift would change behaviour with NO lockfile-reviewed
 * intent must be pinned to EXACT versions, and the root manifest must declare an
 * `engines.node` constraint.
 *
 * The pinning policy is by BLAST RADIUS, not by familiarity (#900):
 *
 *   - CORRECTNESS-CRITICAL core (#873): the DB driver, ORM, MCP wire protocol, and
 *     agent SDK. These are pre-1.0 / early where a minor bump can break behaviour.
 *
 *   - TRANSPORT / IPC surface (#900): the HTTP/WebSocket server (hono + its node
 *     adapters), the request/response *wire-validation* layer (zod), and the
 *     desktop IPC bridge (every `@tauri-apps/*`). A `^` minor of hono or a Tauri
 *     plugin can land on the next clean install and change middleware/IPC behaviour
 *     with no lockfile-reviewed intent — exactly the same silent-drift risk as the
 *     core, just on the edges of the system rather than the centre.
 *
 * A caret/tilde range lets an unattended `pnpm install` silently float onto a new
 * minor. Pinning forces every upgrade to be a deliberate, reviewable manifest change
 * that goes through the check suite — instead of drifting in via the lockfile.
 *
 * NOT pinned (deliberately left to float): the UI/build tooling — react/react-dom,
 * vite, tailwind, eslint, tsx, typescript, etc. A bad minor there surfaces LOUDLY and
 * IMMEDIATELY at typecheck/build/test time (it can't reach production undetected), so
 * the silent-drift argument does not apply; pinning them would only add upgrade churn.
 *
 * To upgrade one of these pinned deps: bump the exact version here AND in the lockfile
 * in the same commit, run `pnpm check`, and review the diff.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");

/**
 * Deps that must be pinned to an exact version wherever they appear (in any package,
 * dependencies or devDependencies). These are the silent-breakage-risk packages the
 * arch review flagged — see the blast-radius rationale at the top of this file.
 */
const MUST_BE_EXACT = new Set([
  // Correctness-critical core (#873)
  "@anthropic-ai/claude-agent-sdk",
  "@libsql/client",
  "@modelcontextprotocol/sdk",
  "drizzle-orm",
  "drizzle-kit",
  // Transport / IPC surface (#900)
  "hono",
  "@hono/node-server",
  "@hono/node-ws",
  "zod",
  "@tauri-apps/api",
  "@tauri-apps/cli",
]);

/**
 * Package-name prefixes that must be pinned to an exact version wherever they appear.
 * Covers families where every member is part of the same blast-radius surface — e.g.
 * all `@tauri-apps/*` plugins are the desktop IPC bridge (#900).
 */
const MUST_BE_EXACT_PREFIXES = ["@tauri-apps/"];

function mustBeExact(name: string): boolean {
  return MUST_BE_EXACT.has(name) || MUST_BE_EXACT_PREFIXES.some((p) => name.startsWith(p));
}

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

describe("dependency pinning gate (#873, #900)", () => {
  it("correctness-critical + transport/IPC deps are pinned to exact versions everywhere", () => {
    const offenders: string[] = [];
    for (const rel of MANIFESTS) {
      const manifest = readManifest(rel);
      for (const block of ["dependencies", "devDependencies"] as const) {
        const deps = manifest[block];
        if (!deps) continue;
        for (const [name, spec] of Object.entries(deps)) {
          if (!mustBeExact(name)) continue;
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
