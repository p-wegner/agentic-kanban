// @covers platform.testing.coverage [regression-guard]
// @gate:always-run — reads the ROOT package.json, the arch-gate workflow and all four
// packages' vitest/vite configs; it imports none of them, so import-graph scoping cannot
// see it (#765).
/**
 * Coverage must stay WIRED TO A CONSUMER (#765).
 *
 * #688 installed `@vitest/coverage-v8`, added a `coverage` block to every test package's
 * config, and added a root `pnpm test:coverage`. It then went unread for months, and the
 * failure had two independent halves — this suite guards both, because each one is
 * silently invisible on its own:
 *
 *  1. **The script did not work.** It was
 *     `pnpm --filter A --filter B ... test -- --coverage`. pnpm swallows everything after
 *     `--` in that form: measured on 2026-08-23, `pnpm --filter @agentic-kanban/client
 *     test -- --coverage --reporter=dot src/lib/__tests__` ran all 165 files with the
 *     default reporter and emitted no `coverage/` directory at all. A script that runs
 *     the whole suite and produces nothing looks like it worked.
 *  2. **Nothing read the output.** No workflow and no script mentioned `lcov` or
 *     `coverage-final`, so `code-metrics` found no report
 *     (`provenance.scanners.coverage = "skipped:no_report"`) and fell back to its
 *     co-change proxy for 1375 of 1375 production files. That proxy is wrong in the
 *     direction that matters: `GraphEdges.tsx` scored safety_net 0.00 on it (never
 *     co-committed with a test) and measures 88% line coverage.
 *
 * The predicates below are pure so that each one can be shown to FAIL on the exact
 * pre-#765 input it exists to catch — see the "proven to fail" block at the bottom.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** The four packages `pnpm test:coverage` runs, and where each declares its coverage block. */
const COVERAGE_CONFIGS = [
  { pkg: "shared", config: "packages/shared/vitest.config.ts" },
  { pkg: "server", config: "packages/server/vitest.config.ts" },
  { pkg: "mcp-server", config: "packages/mcp-server/vitest.config.ts" },
  // NOT a vitest.config.ts: the client has no such file and never had one. #765's source
  // ticket concluded from its absence that the client was missing from #688 — it is not,
  // its coverage block lives in the `test:` section of vite.config.ts, and it is in the
  // root script's filter list. Assert the LOCATION so the next reader doesn't re-derive
  // that wrong conclusion.
  { pkg: "client", config: "packages/client/vite.config.ts" },
];

/**
 * Does this script actually reach vitest with `--coverage`?
 *
 * `pnpm … <script> -- --coverage` does not (half 1 above). `pnpm … exec vitest run
 * --coverage` does.
 */
export function coverageScriptReachesVitest(script: string): { ok: boolean; reason?: string } {
  if (!script.includes("--coverage")) return { ok: false, reason: "script never passes --coverage" };
  if (/\btest\s+--\s+/.test(script)) {
    return {
      ok: false,
      reason: "uses `pnpm … test -- <args>`; pnpm swallows everything after `--` so the flags never reach vitest",
    };
  }
  if (!/\bexec\s+vitest\b/.test(script)) {
    return { ok: false, reason: "does not invoke vitest via `exec`, so flag forwarding is not guaranteed" };
  }
  return { ok: true };
}

/** Is there a job in this workflow that both PRODUCES and READS a coverage report? */
export function workflowConsumesCoverage(workflowYaml: string): { ok: boolean; reason?: string } {
  let doc: unknown;
  try {
    doc = YAML.parse(workflowYaml);
  } catch (err) {
    return { ok: false, reason: `unparseable workflow: ${err instanceof Error ? err.message : String(err)}` };
  }
  const jobs = (doc as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> })?.jobs ?? {};
  for (const job of Object.values(jobs)) {
    const steps = job?.steps ?? [];
    const runs = steps.map((s) => String(s.run ?? "")).join("\n");
    const uses = steps.map((s) => String(s.uses ?? "")).join("\n");
    const withPaths = steps.map((s) => JSON.stringify(s.with ?? {})).join("\n");
    const produces = runs.includes("test:coverage");
    const reads = runs.includes("coverage:report") || /lcov|coverage-final/.test(runs);
    const keepsArtifact = uses.includes("upload-artifact") && /lcov/.test(withPaths);
    if (produces && reads && keepsArtifact) return { ok: true };
  }
  return {
    ok: false,
    reason: "no job both runs `pnpm test:coverage`, reads the report, and uploads the lcov artifact",
  };
}

/** Does a package config declare a coverage block that emits lcov (what code-metrics eats)? */
export function configDeclaresLcovCoverage(configSource: string): { ok: boolean; reason?: string } {
  if (!/coverage\s*:\s*\{/.test(configSource)) return { ok: false, reason: "no `coverage:` block" };
  if (!/provider\s*:\s*["']v8["']/.test(configSource)) return { ok: false, reason: "no v8 provider" };
  if (!/["']lcov["']/.test(configSource)) return { ok: false, reason: "coverage block emits no lcov reporter" };
  if (!/["']json-summary["']/.test(configSource)) {
    return { ok: false, reason: "no json-summary reporter — scripts/coverage-report.mjs reads coverage-summary.json" };
  }
  return { ok: true };
}

describe("coverage wiring (#765)", () => {
  const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("`pnpm test:coverage` actually reaches vitest with --coverage", () => {
    const script = rootPkg.scripts["test:coverage"];
    expect(script, "root package.json must keep a test:coverage script").toBeTruthy();
    const verdict = coverageScriptReachesVitest(script);
    expect(verdict.reason ?? "ok").toBe("ok");
    expect(verdict.ok).toBe(true);
  });

  it("a `coverage:report` script exists and points at the reader", () => {
    expect(rootPkg.scripts["coverage:report"]).toContain("scripts/coverage-report.mjs");
    expect(existsSync(path.join(REPO_ROOT, "scripts/coverage-report.mjs"))).toBe(true);
  });

  it("arch-gate.yml has a job that produces, reads and keeps the coverage report", () => {
    const yamlSource = readFileSync(path.join(REPO_ROOT, ".github/workflows/arch-gate.yml"), "utf8");
    const verdict = workflowConsumesCoverage(yamlSource);
    expect(verdict.reason ?? "ok").toBe("ok");
    expect(verdict.ok).toBe(true);
  });

  it.each(COVERAGE_CONFIGS)("$pkg declares an lcov+json-summary coverage block in $config", ({ config }) => {
    const full = path.join(REPO_ROOT, config);
    expect(existsSync(full), `${config} must exist — that is where this package's coverage block lives`).toBe(true);
    const verdict = configDeclaresLcovCoverage(readFileSync(full, "utf8"));
    expect(verdict.reason ?? "ok").toBe("ok");
  });

  it("every package in the coverage script's filter list has a config asserted above", () => {
    const script = rootPkg.scripts["test:coverage"];
    const filtered = [...script.matchAll(/--filter\s+(\S+)/g)].map((m) => m[1]);
    // Map the workspace names in the script to the short package dir names above.
    const shortNames = filtered.map((name) => name.replace(/^@agentic-kanban\//, "").replace(/^agentic-kanban$/, "server"));
    expect(new Set(shortNames)).toEqual(new Set(COVERAGE_CONFIGS.map((c) => c.pkg)));
  });

  // ── proven to fail: each predicate red on the exact pre-#765 input ──────────────────
  describe("the guard is red on the real pre-#765 state", () => {
    it("rejects the arg-swallowing `test -- --coverage` script that #688 shipped", () => {
      const before =
        "pnpm --no-bail --workspace-concurrency=1 --filter @agentic-kanban/shared --filter agentic-kanban " +
        "--filter @agentic-kanban/mcp-server --filter @agentic-kanban/client test -- --coverage";
      const verdict = coverageScriptReachesVitest(before);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/swallows/);
    });

    it("rejects a script that forgets --coverage entirely", () => {
      expect(coverageScriptReachesVitest("pnpm -r exec vitest run").ok).toBe(false);
    });

    it("rejects the pre-#765 arch-gate workflow (god-module job only)", () => {
      const before = [
        "name: arch-gate",
        "on:",
        "  push:",
        "    branches: [master]",
        "jobs:",
        "  god-module-gate:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: pnpm install --frozen-lockfile",
        "      - run: pnpm check:arch",
      ].join("\n");
      const verdict = workflowConsumesCoverage(before);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toMatch(/no job both runs/);
    });

    it("rejects a coverage job that runs the suite but never reads or keeps the report", () => {
      const halfWired = [
        "jobs:",
        "  coverage:",
        "    steps:",
        "      - run: pnpm test:coverage",
      ].join("\n");
      expect(workflowConsumesCoverage(halfWired).ok).toBe(false);
    });

    it("rejects a package config with no coverage block, and one that emits no lcov", () => {
      expect(configDeclaresLcovCoverage("export default defineConfig({ test: { globals: true } });").ok).toBe(false);
      expect(
        configDeclaresLcovCoverage(
          `export default defineConfig({ test: { coverage: { provider: "v8", reporter: ["text"] } } });`,
        ).reason,
      ).toMatch(/lcov/);
    });
  });
});
