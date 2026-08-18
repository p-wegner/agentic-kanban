/**
 * #657 — the smoke gate had its own, narrower health-URL ladder, so a project whose dev
 * ports are computed at RUNTIME had no boot check at all.
 *
 * Split out of #644, which fixed the `isWeb` monorepo detection. That fix landed and this
 * repo now detects `isWeb: true` — and STILL had no boot/render gate, for a second reason:
 * `buildSmokeCheck` resolved its URL only from the persisted stack profile, whose
 * `devPort`/`devHealthUrl` come from a static read of package.json scripts. This board's
 * ports are computed by `scripts/dev.mjs` (main 3001/5173, a worktree 3001+N/5173+N) and
 * `vite.config.ts` carries no literal, so both fields were null and the gate was inert.
 *
 * Meanwhile `resolveProjectDevServerPlan` — the resolver the Diagnostics tab and the
 * dev-server skill already use — honours `health_url_<projectId>` / `dev_command_<projectId>`
 * AND implements the worktree port arithmetic. The fix is to read ITS answer rather than
 * grow a second precedence ladder that can disagree with it.
 */
import { describe, it, expect } from "vitest";
import type { StackProfile } from "@agentic-kanban/shared";
import { buildSmokeCheck } from "../services/stack-profile.service.js";
import type { DevServerPlan } from "../services/dev-server.service.js";

function profile(overrides: Partial<StackProfile>): StackProfile {
  return {
    stack: "node", packageManager: "pnpm", isMonorepo: false, workspaces: [],
    installCommand: "pnpm install", buildCommand: null, testCommand: null, quickTestCommand: null,
    lintCommand: null, typecheckCommand: null, devCommand: null, isWeb: false,
    devHealthUrl: null, devPort: null, testDir: null, testRunner: null,
    source: "detected", detectedMarkers: [], updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function plan(overrides: Partial<DevServerPlan>): DevServerPlan {
  return {
    command: "pnpm dev",
    healthUrl: null,
    port: null,
    isWeb: true,
    source: { command: "profile", healthUrl: "none", port: "none" },
    ...overrides,
  };
}

/** This board's own shape after #644: web, a dev command, and NO static port anywhere. */
const RUNTIME_PORT_PROFILE = profile({ isWeb: true, devCommand: "pnpm dev", devPort: null, devHealthUrl: null });

describe("smoke check reads the dev-server plan (#657)", () => {
  it("was inert for a runtime-computed port — the bug", () => {
    expect(buildSmokeCheck(RUNTIME_PORT_PROFILE)).toBeNull();
  });

  it("runs once the plan supplies a health URL the profile could not know", () => {
    const check = buildSmokeCheck(
      RUNTIME_PORT_PROFILE,
      plan({ healthUrl: "http://127.0.0.1:3001/api/projects", source: { command: "profile", healthUrl: "pref", port: "pref" } }),
    );
    expect(check?.healthUrl).toBe("http://127.0.0.1:3001/api/projects");
  });

  it("prefers the operator's health URL over a profile that has one", () => {
    const check = buildSmokeCheck(
      profile({ isWeb: true, devCommand: "pnpm dev", devHealthUrl: "http://127.0.0.1:9999/stale" }),
      plan({ healthUrl: "http://127.0.0.1:3001/api/health", source: { command: "profile", healthUrl: "pref", port: "pref" } }),
    );
    expect(check?.healthUrl).toBe("http://127.0.0.1:3001/api/health");
  });

  it("prefers the operator's dev command too", () => {
    const check = buildSmokeCheck(
      profile({ isWeb: true, devCommand: "pnpm start", devHealthUrl: "http://127.0.0.1:3001" }),
      plan({ command: "pnpm dev --host", healthUrl: "http://127.0.0.1:3001", source: { command: "pref", healthUrl: "pref", port: "pref" } }),
    );
    expect(check?.devCommand).toBe("pnpm dev --host");
  });

  it("grades a worktree-derived URL leniently — it is arithmetic, not a route a human named", () => {
    // Same reason a guessed root URL off a port is graded on non-5xx: nobody promised
    // 3001+N serves a 200 at the root.
    const check = buildSmokeCheck(
      RUNTIME_PORT_PROFILE,
      plan({ healthUrl: "http://127.0.0.1:3005", source: { command: "profile", healthUrl: "worktree-port", port: "worktree-port" } }),
    );
    expect(check?.acceptNon5xx).toBe(true);
  });

  it("holds an explicitly named health route to the strict 200 bar", () => {
    const check = buildSmokeCheck(
      RUNTIME_PORT_PROFILE,
      plan({ healthUrl: "http://127.0.0.1:3001/api/projects", source: { command: "profile", healthUrl: "pref", port: "pref" } }),
    );
    expect(check?.acceptNon5xx).toBe(false);
  });

  it("changes nothing when no plan is passed — every existing caller is unaffected", () => {
    const p = profile({ isWeb: true, devCommand: "vite", devPort: 5173 });
    expect(buildSmokeCheck(p)).toEqual(buildSmokeCheck(p, null));
  });

  it("still skips a non-web project even when a plan exists", () => {
    const check = buildSmokeCheck(profile({ isWeb: false, devCommand: "node cli.js" }), plan({ healthUrl: "http://127.0.0.1:3001" }));
    expect(check).toBeNull();
  });
});
