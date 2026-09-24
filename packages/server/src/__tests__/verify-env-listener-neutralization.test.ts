// @gate:always-run when:packages/server/src/services/** - reads ../services/*.ts as TEXT, so nothing it asserts on is in its own
// import graph; dependency-based selection cannot see the link (#538).
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
 *  2. ALL THREE spawn sites overlay them — the gate, and the base-branch health probe's
 *     install AND verify calls, the latter now including the #1110 isolated flake-retry
 *     spawn alongside the original full verify run. A pin leaking into the probe is the
 *     worse failure: it is recorded as "the base is red" and then withholds every OTHER
 *     branch's merge too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { envPort, resolveListenHost } from "../lib/bearer-token.js";
import {
  VERIFY_NEUTRALIZED_DB_LOCATION_ENV,
  VERIFY_NEUTRALIZED_LISTENER_ENV,
  buildBaseProbeEnv,
  withNeutralizedListenerEnv,
} from "../lib/verify-env.js";
import { resolveDbLocation } from "@agentic-kanban/shared/lib/db-path";

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

  it("all THREE verify spawn sites apply it — the gate, and both base-probe spawns", () => {
    // Source-level, deliberately: the alternative is booting a whole gate run to observe an
    // env var, and the drift this guards against is someone adding a FOURTH spawn site.
    const gate = read("pre-merge-gate.service.ts");
    expect(gate).toContain("VERIFY_NEUTRALIZED_LISTENER_ENV");
    // In `isolationEnv`, which every branch of `verifyEnv` spreads — not in one branch of it.
    const isolation = gate.slice(gate.indexOf("const isolationEnv = {"));
    expect(isolation.slice(0, isolation.indexOf("};"))).toContain("VERIFY_NEUTRALIZED_LISTENER_ENV");

    const base = read("base-branch-health.service.ts");
    // The install call, the full verify call, and the #1110 isolated flake-retry call: an
    // install command can open a listener too, and the retry is a spawn site in its own right.
    // Since #1231 all three build their env through `buildBaseProbeEnv`, which overlays BOTH
    // neutraliser sets itself (asserted below) and — paired with `inheritEnv: false` — is the
    // whole child env, so the pins cannot arrive by inheritance either.
    const spawns = base.split("runSetupScript(dest,").slice(1);
    expect(spawns.length).toBe(3);
    for (const call of spawns) {
      // Everything before `inheritEnv` must still be INSIDE this call (no `.catch(` yet), so a
      // spawn that dropped the option cannot borrow the next call's.
      const head = call.slice(0, call.indexOf("inheritEnv: false"));
      expect(head).not.toContain(".catch(");
      expect(head).toContain("buildBaseProbeEnv(");
    }
    // The builder applies the neutralisers even when the SOURCE env carries the pins and a
    // caller's `extra` tries to re-introduce one — overlay order is neutralisers over source,
    // then `extra` over that, and `extra` is the probe's own resource vars, never a pin.
    const built = buildBaseProbeEnv({}, { KANBAN_GIT_HTTP_PORT: "3002", KANBAN_DB_URL: "file:/x", PATH: "/bin" });
    expect(built.KANBAN_GIT_HTTP_PORT).toBe("");
    expect(built.KANBAN_DB_URL).toBe("");
    expect(built.PATH).toBe("/bin");
  });
});

/**
 * The same leak one precedence level up (#1041 gate).
 *
 * `KANBAN_DB_URL` outranks the gate's own `AGENTIC_KANBAN_DIR` isolation AND the #231
 * test-runner throwaway redirect, and the board sets it in the environment it launches sessions
 * with — so the gate's vitest workers were opening the LIVE board database. Measured: 13 phantom
 * failures on a file-scoped run of this branch, every one of them green once the variable is
 * cleared.
 */
describe("verify subprocesses do not inherit the board's DB-location overrides (#231, #1041)", () => {
  it("blanks BOTH spellings of the DB-location override", () => {
    // The canonical name and #615's pre-rename alias: `resolveDbLocation` reads them as
    // `KANBAN_DB_URL || DB_URL`, so neutralizing one leaves the identical hole open.
    for (const name of ["KANBAN_DB_URL", "DB_URL"]) {
      expect(VERIFY_NEUTRALIZED_DB_LOCATION_ENV[name], `${name} must be neutralized`).toBe("");
    }
  });

  it("blank reads as ABSENT, so the gate's own AGENTIC_KANBAN_DIR wins again", () => {
    // The real assertion of the fix: with the board's live URL present, the gate's isolation dir
    // is ignored; with it blanked, the isolation dir is what resolves. Asserted through the
    // resolver itself rather than by re-describing its precedence.
    const gateDir = resolve("/tmp/kanban-verify-gate-x");
    const leaked = resolveDbLocation({
      env: { KANBAN_DB_URL: "file:/home/u/.agentic-kanban/kanban.db", AGENTIC_KANBAN_DIR: gateDir },
    });
    expect(leaked.source).toBe("DB_URL");

    const isolated = resolveDbLocation({
      env: { AGENTIC_KANBAN_DIR: gateDir, ...VERIFY_NEUTRALIZED_DB_LOCATION_ENV },
    });
    expect(isolated.source).toBe("AGENTIC_KANBAN_DIR");
    expect(isolated.dir).toBe(gateDir);
  });

  it("all FOUR verify spawn sites apply it — the gate, and all three base-probe spawns", () => {
    // Source-level for the same reason as the listener half above: the drift being guarded
    // against is a fifth spawn site, which no runtime assertion here would ever see.
    const gate = read("pre-merge-gate.service.ts");
    const isolation = gate.slice(gate.indexOf("const isolationEnv = {"));
    expect(isolation.slice(0, isolation.indexOf("};"))).toContain("VERIFY_NEUTRALIZED_DB_LOCATION_ENV");

    const base = read("base-branch-health.service.ts");
    const spawns = base.split("runSetupScript(dest,").slice(1);
    expect(spawns.length).toBe(3);
    for (const call of spawns) {
      // #1231 — via `buildBaseProbeEnv`, which overlays the DB-location neutraliser itself.
      expect(call.slice(0, call.indexOf("inheritEnv: false"))).toContain("buildBaseProbeEnv(");
    }
    const built = buildBaseProbeEnv({}, { KANBAN_DB_URL: "file:/live.db", DB_URL: "file:/old.db" });
    expect(built.KANBAN_DB_URL).toBe("");
    expect(built.DB_URL).toBe("");
  });
});

/**
 * The same leak, generalised (#1231): the probe must inherit NOTHING but an allowlist.
 *
 * The two blanklists above name the pins that had already bitten. What they cannot name is the
 * next scoping knob — and `KANBAN_TEST_*` / `KANBAN_IMPACT_*` / `KANBAN_ARCH_CHANGED_FILES` /
 * `KANBAN_RETRY_TEST_FILES` reaching `scripts/test-mine.mjs` from the board process turn the one
 * FULL-suite signal behind `pnpm promote` into a scoped run (the 2026-09-18/19 red rows carried
 * an impact-selector-only line). So every probe spawn now builds its env with `buildBaseProbeEnv`
 * (allowlist from scratch) AND passes `inheritEnv: false`, the half without which the allowlist
 * is decoration. The behavioural half — what the builder keeps and drops, and that the child
 * really sees none of it — is `base-probe-env.test.ts`; this half pins the SOURCE, because the
 * drift being guarded against is a fourth spawn site or a dropped option.
 */
describe("the base probe's children start from an allowlist, never process.env (#1231)", () => {
  it("all THREE probe spawn sites pass inheritEnv: false with a buildBaseProbeEnv env", () => {
    const base = read("base-branch-health.service.ts");
    const spawns = base.split("runSetupScript(dest,").slice(1);
    expect(spawns.length).toBe(3);
    for (const call of spawns) {
      // Everything before `inheritEnv` must still be INSIDE this call (no `.catch(` yet), so a
      // spawn that dropped the option cannot borrow the next call's.
      const head = call.slice(0, call.indexOf("inheritEnv: false"));
      expect(head).not.toContain(".catch(");
      expect(head).toContain("buildBaseProbeEnv(");
      expect(head).not.toContain("process.env");
    }
  });

  it("the retry spawn is the ONLY one that names a scoping key, and it is KANBAN_RETRY_TEST_FILES", () => {
    const base = read("base-branch-health.service.ts");
    const spawns = base.split("runSetupScript(dest,").slice(1);
    const heads = spawns.map((call) => call.slice(0, call.indexOf("inheritEnv: false")));
    const scoping = /KANBAN_(TEST_(?!MAX_WORKERS)\w+|IMPACT_\w+|ARCH_CHANGED_FILES|RETRY_TEST_FILES)/g;
    expect(heads[0].match(scoping)).toBeNull(); // install
    expect(heads[1].match(scoping)).toBeNull(); // full verify
    expect([...new Set(heads[2].match(scoping))]).toEqual(["KANBAN_RETRY_TEST_FILES"]); // flake retry
  });
});
