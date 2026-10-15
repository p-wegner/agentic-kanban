import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkerVerifyCapability } from "@agentic-kanban/shared/lib/worker-verify-protocol";
import { createDaemonVerifyRunner, sweepOrphanVerifyCheckouts } from "../worker/worker-verify-runner.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "ak-verify-1479-")); roots.push(d); return d; };

const job = (jobId: string) => ({
  type: "verify_job" as const, jobId, sha: "a".repeat(40), tier: "full", script: "x", timeoutMs: 60_000,
  auth: { projectId: "p", gitPort: 1, gitToken: "t", branch: "b", incomingRef: "r" },
});

describe("#1479 worker verify visibility", () => {
  it("capability carries in-flight job ids, logs the lifecycle, and survives the wire parse", async () => {
    const lines: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const root = tmp();
    const runner = createDaemonVerifyRunner({
      workRoot: root, boardUrl: () => "http://x", sendToBoard: () => undefined, log: (l) => lines.push(l), slots: 2, ramGb: 32,
      prepareCheckout: async () => ({ ok: true, dir: join(root, "verify", "j1"), sha: "a".repeat(40) }),
      runScript: async () => { await gate; return { exitCode: 0, timedOut: false, output: "ok" }; },
      cleanup: async () => undefined,
    });
    runner.handle(job("j1"));
    await new Promise((r) => setTimeout(r, 20));
    const cap = runner.capability();
    expect(cap).toMatchObject({ slots: 2, freeSlots: 1, jobIds: ["j1"] });
    expect(parseWorkerVerifyCapability(JSON.parse(JSON.stringify(cap)))?.jobIds).toEqual(["j1"]);
    runner.onConnected();
    release();
    await new Promise((r) => setTimeout(r, 20));
    const text = lines.join("\n");
    expect(text).toMatch(/verify job j1 started/);
    expect(text).toMatch(/verify job j1 stage verify/);
    expect(text).toMatch(/re-sync on connect: running \[j1\]/);
    expect(text).toMatch(/verify job j1 finished: passed/);
    expect(runner.capability()).toMatchObject({ freeSlots: 2, jobIds: [] });
  });

  it("cleans a half-made checkout when the job is refused before the checkout is reported", async () => {
    const root = tmp();
    const stray = join(root, "verify", "j2");
    const cleaned: string[] = [];
    const lines: string[] = [];
    const runner = createDaemonVerifyRunner({
      workRoot: root, boardUrl: () => "http://x", sendToBoard: () => undefined, log: (l) => lines.push(l), slots: 1, ramGb: 8,
      prepareCheckout: async () => ({ ok: false, refused: "sha_mismatch", reason: "wrong tree" }),
      cleanup: async (_j, d) => { cleaned.push(d); },
    });
    mkdirSync(stray, { recursive: true }); // made after the startup sweep, like a half-made checkout
    runner.handle(job("j2"));
    await new Promise((r) => setTimeout(r, 20));
    expect(cleaned).toEqual([stray]);
    expect(lines.join("\n")).toMatch(/verify job j2 refused \(sha_mismatch\)/);
  });

  it("the startup sweep removes orphan checkouts and keeps the named ones", () => {
    const root = tmp();
    for (const id of ["old1", "old2", "live"]) { mkdirSync(join(root, "verify", id), { recursive: true }); writeFileSync(join(root, "verify", id, "f"), "x"); }
    expect(sweepOrphanVerifyCheckouts(root, new Set(["live"])).sort()).toEqual(["old1", "old2"]);
    expect(existsSync(join(root, "verify", "old1"))).toBe(false);
    expect(existsSync(join(root, "verify", "live"))).toBe(true);
    expect(sweepOrphanVerifyCheckouts(join(root, "nowhere"))).toEqual([]);
  });
});
