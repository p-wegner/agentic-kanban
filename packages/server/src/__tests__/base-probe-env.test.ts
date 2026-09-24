/**
 * The base-branch health probe's children inherit NOTHING from the board process except an
 * allowlist (#1231) — the behavioural half. The source-level half (all three spawn sites pass
 * `inheritEnv: false` with a `buildBaseProbeEnv` env) lives in
 * `verify-env-listener-neutralization.test.ts`, which is the guard suite for this family.
 *
 * The probe is the one full-suite signal behind `pnpm promote`. `runSetupScript` spreads
 * `options.env` over `process.env`, so every `KANBAN_TEST_*` / `KANBAN_IMPACT_*` scoping var the
 * board process happens to carry reached `scripts/test-mine.mjs` and turned the "full" probe into
 * a scoped or selector run — the red sweep rows of 2026-09-18/19 carried a line only the
 * impact-selector path prints.
 */
import { describe, it, expect, afterEach } from "vitest";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import { BASE_PROBE_ENV_ALLOWLIST, buildBaseProbeEnv } from "../lib/verify-env.js";
import { buildVerifyResourceEnv } from "../services/verify-resource-env.js";

/** The exact keys the ticket names, plus more of the two families they belong to. */
const SEEDED: Record<string, string> = {
  KANBAN_TEST_SELECTOR: "impact",
  KANBAN_TEST_FILES: "x",
  KANBAN_IMPACT_BASE: "y",
  KANBAN_RETRY_TEST_FILES: "z",
  KANBAN_ARCH_CHANGED_FILES: "a.ts,b.ts",
  KANBAN_TEST_PACKAGES: "server",
  KANBAN_TEST_GUARDS_ONLY: "1",
  KANBAN_IMPACT_CLI: "/nowhere/impact.mjs",
};

const isScopingKey = (key: string) =>
  key.startsWith("KANBAN_TEST_") ||
  key.startsWith("KANBAN_IMPACT_") ||
  key === "KANBAN_ARCH_CHANGED_FILES" ||
  key === "KANBAN_RETRY_TEST_FILES";

const saved = new Map<string, string | undefined>();
function seedProcessEnv() {
  for (const [key, value] of Object.entries(SEEDED)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
}
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("buildBaseProbeEnv is an allowlist, never a spread over process.env (#1231)", () => {
  it("drops every KANBAN_TEST_* / KANBAN_IMPACT_* / ARCH_CHANGED / RETRY key the board process carries", () => {
    seedProcessEnv();
    const resources = buildVerifyResourceEnv(2);
    const env = buildBaseProbeEnv(resources);
    // What survives of the scoping families is EXACTLY the worker cap the probe sets on purpose —
    // nothing the board process happened to carry.
    const scopingKeys = Object.keys(env).filter(isScopingKey).sort();
    expect(scopingKeys).toEqual(Object.keys(resources).filter(isScopingKey).sort());
    expect(scopingKeys).toEqual(["KANBAN_TEST_MAX_WORKERS"]);
    for (const key of Object.keys(SEEDED)) {
      expect(env, `${key} must not reach the probe`).not.toHaveProperty(key);
    }
  });

  it("the flake retry carries KANBAN_RETRY_TEST_FILES and ONLY that scoping key, because it IS the retry", () => {
    seedProcessEnv();
    const resources = buildVerifyResourceEnv(2);
    const env = buildBaseProbeEnv({ ...resources, KANBAN_RETRY_TEST_FILES: "server:src/__tests__/a.test.ts" });
    expect(env.KANBAN_RETRY_TEST_FILES).toBe("server:src/__tests__/a.test.ts");
    const scopingKeys = Object.keys(env).filter(isScopingKey).sort();
    expect(scopingKeys).toEqual(["KANBAN_RETRY_TEST_FILES", "KANBAN_TEST_MAX_WORKERS"]);
    // Still none of the seeded ones: the retry key came from `extra`, not from inheritance.
    expect(env.KANBAN_TEST_SELECTOR).toBeUndefined();
    expect(env.KANBAN_IMPACT_BASE).toBeUndefined();
  });

  it("keeps what the shell, node, pnpm and git need, matched case-insensitively (Windows spells Path/Temp its own way)", () => {
    const env = buildBaseProbeEnv({}, {
      Path: "C:\\bin",
      Temp: "C:\\t",
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      USERPROFILE: "C:\\Users\\x",
      HOME: "/home/x",
      APPDATA: "C:\\Users\\x\\AppData\\Roaming",
      PNPM_HOME: "C:\\pnpm",
      npm_execpath: "C:\\pnpm\\pnpm.cjs",
      NODE_ENV: "production",
      VITEST_MAX_THREADS: "8",
      AGENTIC_KANBAN_DIR: "/somewhere",
      KANBAN_HOST: "0.0.0.0",
    });
    // Original spelling is preserved — cmd.exe and pnpm read the key as the parent wrote it.
    expect(env.Path).toBe("C:\\bin");
    expect(env.Temp).toBe("C:\\t");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.ComSpec).toContain("cmd.exe");
    expect(env.USERPROFILE).toBe("C:\\Users\\x");
    expect(env.HOME).toBe("/home/x");
    expect(env.APPDATA).toContain("Roaming");
    expect(env.PNPM_HOME).toBe("C:\\pnpm");
    expect(env.npm_execpath).toBe("C:\\pnpm\\pnpm.cjs");
    // Board configuration and test-runner knobs are not machine facts and do not cross.
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.VITEST_MAX_THREADS).toBeUndefined();
    expect(env.AGENTIC_KANBAN_DIR).toBeUndefined();
    expect(env.KANBAN_HOST).toBeUndefined();
  });

  it("the allowlist itself names no KANBAN_* key — the neutralisers and resource vars are layered on explicitly", () => {
    for (const key of BASE_PROBE_ENV_ALLOWLIST) {
      expect(key.toUpperCase().startsWith("KANBAN_"), `${key} must not be allowlisted`).toBe(false);
    }
    // And the neutralisers are present (blank = absent for every consumer, see verify-env.ts).
    const env = buildBaseProbeEnv();
    expect(env.KANBAN_GIT_HTTP_PORT).toBe("");
    expect(env.KANBAN_DB_URL).toBe("");
  });

  it("runSetupScript honours inheritEnv: false end to end — a seeded scoping var never reaches the child", async () => {
    seedProcessEnv();
    const probe = "node -e \"process.stdout.write(JSON.stringify(process.env))\"";
    const result = await runSetupScript(process.cwd(), probe, {
      env: buildBaseProbeEnv({ KANBAN_TEST_MAX_WORKERS: "1", PROBE_MARKER: "here" }),
      inheritEnv: false,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnv.PROBE_MARKER).toBe("here");
    expect(childEnv.KANBAN_TEST_MAX_WORKERS).toBe("1");
    for (const key of Object.keys(SEEDED)) {
      expect(childEnv, `${key} leaked into the child`).not.toHaveProperty(key);
    }
  }, 40_000);

  it("the default (inheritEnv omitted) still spreads over process.env — the opt-out is explicit", async () => {
    seedProcessEnv();
    const probe = "node -e \"process.stdout.write(process.env.KANBAN_TEST_SELECTOR || '<unset>')\"";
    const result = await runSetupScript(process.cwd(), probe, { env: { PROBE_MARKER: "here" }, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("impact");
  }, 40_000);
});
