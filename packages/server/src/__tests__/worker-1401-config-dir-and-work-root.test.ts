import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkerCheckoutTrust } from "../cli/commands/worker-doctor-checkout-trust.js";
import { defaultWorkerWorkRoot } from "../worker/worker-repo.js";

describe("#1401 work root default", () => {
  it("is the shared root for the default state file or none", () => {
    const shared = join(homedir(), ".agentic-kanban", "worker");
    expect(defaultWorkerWorkRoot()).toBe(shared);
    expect(defaultWorkerWorkRoot(join(homedir(), ".agentic-kanban", "worker-state.json"))).toBe(shared);
  });
  it("is separate per non-default state file", () => {
    const a = defaultWorkerWorkRoot(join(tmpdir(), "d3-state.json"));
    const b = defaultWorkerWorkRoot(join(tmpdir(), "d4-state.json"));
    expect(a).not.toBe(b);
    expect(a).toBe(join(tmpdir(), "d3-state-work"));
  });
});

describe("#1401 trust check reads the harness config dir", () => {
  it("consults only the harness .claude.json when given", () => {
    const root = mkdtempSync(join(tmpdir(), "t1401-"));
    const workRoot = join(root, "w");
    const repo = join(workRoot, "repos", "p1");
    mkdirSync(repo, { recursive: true });
    const cfg = join(root, "cfg");
    mkdirSync(cfg);
    const key = repo.split("\\").join("/");
    writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ projects: { [key]: { hasTrustDialogAccepted: true } } }));
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".claude.json"), "{}");
    const check = checkWorkerCheckoutTrust(workRoot, home, cfg);
    expect(check.status).toBe("pass");
    expect(check.detail).toContain(join(cfg, ".claude.json"));
    expect(check.detail).not.toContain(join(home, ".claude.json"));
  });
});
