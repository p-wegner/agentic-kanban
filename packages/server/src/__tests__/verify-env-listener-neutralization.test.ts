/**
 * A verify subprocess must not inherit the board's OWN listener pins.
 *
 * Regression for the #846 gate, where six failures across `git-token-persistence` and
 * `remote-session-socket-gap` were caused by `KANBAN_GIT_HTTP_PORT=3002` /
 * `KANBAN_GIT_HTTP_HOST=<tailnet ip>` leaking from the board process into the test run — the
 * board was holding that exact socket, so every suite that opened a git transport got
 * `EADDRINUSE` and the branch (a `package.json` one-liner) was blamed for it.
 *
 * Two halves, because the leak has two doors and only one of them was ever visible:
 *  1. the VALUES are the ones every consumer reads as "absent" (a spread cannot delete);
 *  2. BOTH spawn sites overlay them — the gate and the base-branch health probe. A pin
 *     leaking into the probe is the worse failure: it is recorded as "the base is red" and
 *     then withholds every OTHER branch's merge too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envPort, resolveListenHost } from "../lib/bearer-token.js";
import { VERIFY_NEUTRALIZED_LISTENER_ENV, withNeutralizedListenerEnv } from "../lib/verify-env.js";

const SERVICES = join(__dirname, "..", "services");
const read = (f: string) => readFileSync(join(SERVICES, f), "utf-8");

describe("verify subprocesses do not inherit the board's listener pins (#846 gate)", () => {
  it("blanks every variable that would make a test bind the board's live socket", () => {
    for (const name of [
      "KANBAN_FLEET_PORT",
      "KANBAN_FLEET_HOST",
      "KANBAN_GIT_HTTP_PORT",
      "KANBAN_GIT_HTTP_HOST",
      "KANBAN_FLEET_INSECURE",
    ]) {
      expect(VERIFY_NEUTRALIZED_LISTENER_ENV[name], `${name} must be neutralized`).toBe("");
    }
  });

  it("the blanked values read as ABSENT, which is the whole reason blanking works", () => {
    // A spread cannot express a deletion, so "" has to mean the same as unset downstream.
    const env = { ...VERIFY_NEUTRALIZED_LISTENER_ENV } as NodeJS.ProcessEnv;
    // fleet: null = the listener is not opened at all.
    expect(envPort("KANBAN_FLEET_PORT", { fallback: null, logPrefix: "[t]", onInvalid: "x" }, env)).toBeNull();
    // git: 0 = OS-assigned, i.e. a port nobody else can already be holding.
    expect(envPort("KANBAN_GIT_HTTP_PORT", { fallback: 0, logPrefix: "[t]", onInvalid: "x" }, env)).toBe(0);
    // host: loopback, never the tailnet interface the operator pinned — and never 0.0.0.0,
    // which is why KANBAN_FLEET_INSECURE is blanked alongside the hosts.
    expect(resolveListenHost({ raw: env.KANBAN_GIT_HTTP_HOST, insecure: env.KANBAN_FLEET_INSECURE, logPrefix: "[t]" })).toBe("127.0.0.1");
    expect(resolveListenHost({ raw: env.KANBAN_FLEET_HOST, insecure: env.KANBAN_FLEET_INSECURE, logPrefix: "[t]" })).toBe("127.0.0.1");
  });

  it("overlays LAST, so a caller's own env cannot re-introduce a pin", () => {
    const merged = withNeutralizedListenerEnv({ KANBAN_GIT_HTTP_PORT: "3002", AGENTIC_KANBAN_DIR: "/tmp/gate" });
    expect(merged.KANBAN_GIT_HTTP_PORT).toBe("");
    expect(merged.AGENTIC_KANBAN_DIR).toBe("/tmp/gate");
  });

  it("BOTH verify spawn sites apply it — the gate and the base-branch health probe", () => {
    // Source-level, deliberately: the alternative is booting a whole gate run to observe an
    // env var, and the drift this guards against is someone adding a THIRD spawn site.
    const gate = read("pre-merge-gate.service.ts");
    expect(gate).toContain("VERIFY_NEUTRALIZED_LISTENER_ENV");
    // In `isolationEnv`, which every branch of `verifyEnv` spreads — not in one branch of it.
    const isolation = gate.slice(gate.indexOf("const isolationEnv = {"));
    expect(isolation.slice(0, isolation.indexOf("};"))).toContain("VERIFY_NEUTRALIZED_LISTENER_ENV");

    const base = read("base-branch-health.service.ts");
    // Both the install and the verify call: an install command can open a listener too.
    const spawns = base.split("runSetupScript(dest,").slice(1);
    expect(spawns.length).toBe(2);
    for (const call of spawns) {
      expect(call.slice(0, call.indexOf(")"))).toContain("VERIFY_NEUTRALIZED_LISTENER_ENV");
    }
  });
});
