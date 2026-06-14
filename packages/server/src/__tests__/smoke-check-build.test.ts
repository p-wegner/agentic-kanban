import { describe, it, expect } from "vitest";
import type { StackProfile } from "@agentic-kanban/shared";
import { buildSmokeCheck } from "../services/stack-profile.service.js";

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

describe("buildSmokeCheck", () => {
  it("returns null for a non-web project (CLI/library skips cleanly)", () => {
    const p = profile({ isWeb: false, devCommand: "node cli.js" });
    expect(buildSmokeCheck(p)).toBeNull();
  });

  it("returns null when there is no profile at all", () => {
    expect(buildSmokeCheck(null)).toBeNull();
  });

  it("returns null for a web project with no dev command", () => {
    const p = profile({ isWeb: true, devCommand: null, devHealthUrl: "http://localhost:5173" });
    expect(buildSmokeCheck(p)).toBeNull();
  });

  it("returns null for a web project with no resolvable health URL or port", () => {
    const p = profile({ isWeb: true, devCommand: "pnpm dev", devHealthUrl: null, devPort: null });
    expect(buildSmokeCheck(p)).toBeNull();
  });

  it("builds a check from devHealthUrl for a browser-UI dev server with render assertions", () => {
    const p = profile({ isWeb: true, devCommand: "pnpm vite dev", devHealthUrl: "http://localhost:5173" });
    expect(buildSmokeCheck(p)).toEqual({
      devCommand: "pnpm vite dev",
      healthUrl: "http://localhost:5173",
      expectBodyContains: ["<html", "<body"],
    });
  });

  it("derives the health URL from devPort when no explicit URL is set", () => {
    const p = profile({ isWeb: true, devCommand: "pnpm vite dev", devHealthUrl: null, devPort: 3000 });
    const check = buildSmokeCheck(p);
    expect(check?.healthUrl).toBe("http://127.0.0.1:3000");
  });

  it("asserts only HTTP-200 (no body needles) for a headless HTTP service", () => {
    // A hono/express JSON API serves no HTML shell — assert on the 200 alone.
    const p = profile({ isWeb: true, devCommand: "node server.js", devHealthUrl: "http://localhost:8080/health" });
    const check = buildSmokeCheck(p);
    expect(check).not.toBeNull();
    expect(check?.expectBodyContains).toEqual([]);
  });

  it("recognizes next/angular/svelte dev servers as browser UIs", () => {
    for (const cmd of ["next dev", "ng serve", "pnpm svelte-kit dev", "npm run react-scripts start"]) {
      const p = profile({ isWeb: true, devCommand: cmd, devHealthUrl: "http://localhost:3000" });
      expect(buildSmokeCheck(p)?.expectBodyContains).toEqual(["<html", "<body"]);
    }
  });
});
