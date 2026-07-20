import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runSmokeCheck, type SmokeCheck } from "../src/lib/smoke-check.js";

const tmpDirs: string[] = [];

afterEach(() => {
  // The just-killed dev-server process can briefly hold its cwd open on Windows (EPERM);
  // cleanup is best-effort — a leftover temp dir must not fail the test.
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// A dev command that boots a Node HTTP server serving `body` with `status` on `port`.
// Writing the server to a temp .js file (rather than `node -e "..."`) sidesteps shell
// quote-escaping differences between cmd.exe and /bin/sh, which break inline eval.
function serverCommand(port: number, status: number, body: string): { cmd: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "smoke-srv-"));
  tmpDirs.push(dir);
  const script = `require('http').createServer((q,s)=>{s.writeHead(${status},{'Content-Type':'text/html'});s.end(${JSON.stringify(body)})}).listen(${port},'127.0.0.1');`;
  writeFileSync(join(dir, "server.js"), script, "utf8");
  return { cmd: "node server.js", dir };
}

// Ask the OS for a free port (bind :0, read the assigned port, release it) instead of
// GUESSING one in a fixed range (#65). The old `30000 + random(30000)` guess flaked ~30%
// on this Windows host: large blocks of that range are RESERVED by WinNAT / Hyper-V /
// Docker Desktop (`netsh int ipv4 show excludedportrange`), so `node listen()` failed with
// `EACCES: permission denied` — the server process exited before serving and every
// server-booting test in the file went red at once. An OS-assigned ephemeral port is never
// in an excluded range (the OS wouldn't hand it out), which eliminates the EACCES class;
// the dedup set stops two rapid calls reusing the same just-freed number within a run.
const usedPorts = new Set<number>();
async function port(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const p = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const assigned = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(assigned));
      });
    });
    if (p && !usedPorts.has(p)) {
      usedPorts.add(p);
      return p;
    }
  }
  throw new Error("could not obtain a free port after 20 attempts");
}

// Pass-path probes succeed on the first poll; fail-path probes run to this short timeout.
const FAST = { timeoutSeconds: 6, pollIntervalSeconds: 1, requestTimeoutMs: 2000 };

describe("runSmokeCheck", () => {
  it("skips cleanly (no-op) when there is no SmokeCheck", async () => {
    const result = await runSmokeCheck(tmpdir(), null);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("passes when the server boots and returns HTTP-200 with the expected render content", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 200, "<html><body><div id='root'>App</div></body></html>");
    const check: SmokeCheck = { devCommand: cmd, healthUrl: `http://127.0.0.1:${p}`, expectBodyContains: ["<html", "<body"] };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.status).toBe(200);
  });

  it("passes on a 200 alone when there are no body assertions (headless service)", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 200, '{"ok":true}');
    const check: SmokeCheck = { devCommand: cmd, healthUrl: `http://127.0.0.1:${p}/health`, expectBodyContains: [] };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(true);
  });

  // #121: the pre-merge gate hit `/` on a JSON-only API (shopcart/Ktor), got 404, and failed the
  // gate even though the server was healthy. Under `acceptNon5xx` the 404 proves the port bound
  // and the router replied — which is all a GUESSED root-URL probe can honestly assert.
  it("passes on a 404 when acceptNon5xx is set (JSON API with no root route)", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 404, '{"error":"not found"}');
    const check: SmokeCheck = {
      devCommand: cmd,
      healthUrl: `http://127.0.0.1:${p}`,
      expectBodyContains: [],
      acceptNon5xx: true,
    };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(true);
    expect(result.status).toBe(404);
  }, 15000);

  it("still fails on a 404 without acceptNon5xx (explicit health route must answer 200)", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 404, '{"error":"not found"}');
    const check: SmokeCheck = { devCommand: cmd, healthUrl: `http://127.0.0.1:${p}/health`, expectBodyContains: [] };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(404);
  }, 15000);

  it("still fails on a 5xx even with acceptNon5xx (a broken server is not 'up')", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 503, "boom");
    const check: SmokeCheck = {
      devCommand: cmd,
      healthUrl: `http://127.0.0.1:${p}`,
      expectBodyContains: [],
      acceptNon5xx: true,
    };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(503);
  }, 15000);

  it("fails when the server returns a non-200 status", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 500, "boom");
    const check: SmokeCheck = { devCommand: cmd, healthUrl: `http://127.0.0.1:${p}`, expectBodyContains: [] };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(500);
    expect(result.message).toContain("500");
  }, 15000);

  it("fails when 200 is returned but the body is missing the expected render content", async () => {
    const p = await port();
    const { cmd, dir } = serverCommand(p, 200, "just plain text, no html shell");
    const check: SmokeCheck = { devCommand: cmd, healthUrl: `http://127.0.0.1:${p}`, expectBodyContains: ["<html", "<body"] };
    const result = await runSmokeCheck(dir, check, FAST);
    expect(result.passed).toBe(false);
    expect(result.status).toBe(200);
    expect(result.message.toLowerCase()).toContain("missing expected content");
  }, 15000);

  it("fails (does not hang) when the server never becomes reachable", async () => {
    // Bind nothing — poll an unused port until the short timeout elapses.
    const p = await port();
    const check: SmokeCheck = {
      devCommand: process.platform === "win32" ? "cmd /c echo noserver" : "true",
      healthUrl: `http://127.0.0.1:${p}`,
      expectBodyContains: [],
    };
    const result = await runSmokeCheck(tmpdir(), check, { timeoutSeconds: 4, pollIntervalSeconds: 1, requestTimeoutMs: 1000 });
    expect(result.passed).toBe(false);
    expect(result.status).toBe(0);
  }, 15000);
});
