// @gate:always-run when:scripts/promote-ci.mjs,scripts/promote-ci.d.mts,scripts/promote-plan.mjs — imports scripts/promote-ci.mjs, which no package-local diff links to (#687); pins the promotion's CI read to the server module's formats (#1562).
/**
 * #1562 — the board's watch on GitHub CI for the base branch: run selection, the red streak, the
 * chip/ATTENTION line, the heal-ticket text, and the promotion's own read of the same data.
 */
import { describe, expect, it } from "vitest";
import {
  ciHealBody,
  ciHealExternalKey,
  formatCiRed,
  parseFailedJobs,
  parseGhRunList,
  parseRequiredWorkflows,
  summarizeWorkflows,
  toCiSnapshot,
  type GhRun,
} from "../lib/ci-status.js";
import { evaluatePromoteCi, formatCiRefusal, readCiForSha } from "../../../../scripts/promote-ci.mjs";
import { formatPromoteUsage, parsePromoteArgv } from "../../../../scripts/promote-plan.mjs";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const run = (workflowName: string, n: number, conclusion: string | null, extra: Partial<GhRun> = {}): GhRun => ({
  databaseId: n,
  workflowName,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  headSha: `sha${n}`,
  url: `https://github.com/o/r/actions/runs/${n}`,
  createdAt: new Date(T0 + n * 86_400_000).toISOString(),
  event: "push",
  ...extra,
});

describe("summarizeWorkflows", () => {
  it("a red streak across two runs is sustained and dated from the oldest failing run", () => {
    const [s] = summarizeWorkflows([run("arch-gate", 4, "failure"), run("arch-gate", 3, "failure"), run("arch-gate", 2, "success")]);
    expect(s).toMatchObject({ workflow: "arch-gate", verdict: "red", redRuns: 2, sustained: true });
    expect(s.redSince).toBe(run("arch-gate", 3, null).createdAt);
    expect(formatCiRed(s)).toBe(`CI red: arch-gate since 2026-10-04, run https://github.com/o/r/actions/runs/4`);
  });

  it("a single red run is reported but not sustained", () => {
    const [s] = summarizeWorkflows([run("security-scan", 3, "failure"), run("security-scan", 2, "success")]);
    expect(s).toMatchObject({ verdict: "red", redRuns: 1, sustained: false });
  });

  it("steps over in-flight and cancelled runs; a newer success clears the red", () => {
    expect(summarizeWorkflows([run("a", 5, null), run("a", 4, "cancelled"), run("a", 3, "failure"), run("a", 2, "failure")])[0]).toMatchObject({ verdict: "red", redRuns: 2 });
    expect(summarizeWorkflows([run("a", 5, "success"), run("a", 4, "failure"), run("a", 3, "failure")])[0].verdict).toBe("green");
    expect(summarizeWorkflows([run("a", 1, null)])[0].verdict).toBe("pending");
  });

  it("defaults to every push workflow; a required list narrows it (case-insensitive)", () => {
    const runs = [run("arch-gate", 2, "failure"), run("lint", 2, "success"), run("nightly", 2, "failure", { event: "schedule" })];
    expect(summarizeWorkflows(runs).map((s) => s.workflow)).toEqual(["arch-gate", "lint"]);
    expect(summarizeWorkflows(runs, parseRequiredWorkflows(" ARCH-gate , ")).map((s) => s.workflow)).toEqual(["arch-gate"]);
  });
});

describe("snapshot, parsing and ticket text", () => {
  it("only sustained reds reach the snapshot", () => {
    const states = summarizeWorkflows([run("a", 3, "failure"), run("a", 2, "failure"), run("b", 3, "failure"), run("b", 2, "success")]);
    const snap = toCiSnapshot("master", states, "2026-10-17T00:00:00.000Z");
    expect(snap.red.map((r) => r.workflow)).toEqual(["a"]);
  });

  it("parseGhRunList rejects non-arrays and drops malformed rows", () => {
    expect(parseGhRunList("not json")).toBeNull();
    expect(parseGhRunList("{}")).toBeNull();
    expect(parseGhRunList(JSON.stringify([{ workflowName: "a", status: "completed", conclusion: "success" }, { nope: 1 }]))).toHaveLength(1);
  });

  it("names the failing job and step; keys are per project and workflow", () => {
    const failed = parseFailedJobs(JSON.stringify({ jobs: [{ name: "build", conclusion: "success" }, { name: "gate", conclusion: "failure", steps: [{ name: "Run check:arch", conclusion: "failure" }, { name: "Setup", conclusion: "success" }] }] }));
    expect(failed).toEqual([{ job: "gate", steps: ["Run check:arch"] }]);
    const [state] = summarizeWorkflows([run("arch-gate", 3, "failure"), run("arch-gate", 2, "failure")]);
    const body = ciHealBody("master", state, failed);
    expect(body).toContain("`gate`");
    expect(body).toContain("Run check:arch");
    expect(ciHealExternalKey("p1", "arch-gate")).toBe("ci-heal:p1:arch-gate");
  });
});

describe("promotion CI read (scripts/promote-ci.mjs)", () => {
  it("refuses on a red required workflow, the newest run per workflow wins", () => {
    const v = evaluatePromoteCi([run("arch-gate", 2, "failure"), run("arch-gate", 1, "success"), run("lint", 2, "success")]);
    expect(v.ok).toBe(false);
    expect(v.red).toEqual([{ workflow: "arch-gate", url: "https://github.com/o/r/actions/runs/2" }]);
    expect(formatCiRefusal(v, "abc")).toContain("--ignore-ci");
    expect(evaluatePromoteCi([run("arch-gate", 2, "success"), run("arch-gate", 1, "failure")]).ok).toBe(true);
  });

  it("a red workflow outside the required list does not refuse; pending and empty do not either", () => {
    expect(evaluatePromoteCi([run("arch-gate", 2, "failure"), run("lint", 2, "success")], ["lint"]).ok).toBe(true);
    expect(evaluatePromoteCi([run("lint", 2, null)]).pending).toEqual(["lint"]);
    expect(evaluatePromoteCi([]).detail).toMatch(/no GitHub Actions run/);
  });

  it("skips cleanly when gh cannot answer", () => {
    const missing = readCiForSha("abc", { exec: () => { throw Object.assign(new Error("spawn gh ENOENT"), { stderr: "" }); } });
    expect(missing.available).toBe(false);
    const ok = readCiForSha("abc", { exec: () => JSON.stringify([run("lint", 2, "success")]) });
    expect(ok.available).toBe(true);
  });

  it("--ignore-ci is a known flag and documented", () => {
    expect(parsePromoteArgv(["--ignore-ci"])).toMatchObject({ ok: true, ignoreCi: true });
    expect(parsePromoteArgv([])).toMatchObject({ ignoreCi: false });
    expect(formatPromoteUsage()).toContain("--ignore-ci");
  });
});
