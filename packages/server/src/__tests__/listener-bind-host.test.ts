/**
 * #652 — the two off-loopback listeners bind every interface and there was no way to say
 * otherwise. On a VPN the intended posture is "listen on the tailnet address only", and
 * opening a fleet port therefore also published it on the office LAN, the home LAN and
 * hotel wifi. Both surfaces bearer-authenticate every request, so this is defence in
 * depth — but the second listener exists precisely to expose the minimum deliberately,
 * and the interface is part of that minimum.
 *
 * The contract these tests pin: a value the operator did set is honoured verbatim — no
 * rewriting, no silent fallback that would leave the port wider open than the operator
 * was told.
 *
 * #753 CHANGED WHAT ABSENT MEANS, deliberately. It used to be `0.0.0.0`, chosen as "no
 * behaviour change for anyone" — but both listeners are plaintext HTTP carrying a bearer
 * credential, so pinning a fleet port published that channel on every interface the
 * machine happens to be on as a side effect. Absent now means loopback, and every
 * interface has to be asked for by name (`KANBAN_FLEET_INSECURE=1`). The direction of the
 * change is the point: the old default could only be too wide, the new one too narrow,
 * and too narrow fails visibly.
 */
import { describe, it, expect } from "vitest";
import { resolveFleetHost } from "../services/fleet-listener.service.js";
import { resolveConfiguredGitHost } from "../services/git-http.service.js";

const RESOLVERS: Array<[string, (env: NodeJS.ProcessEnv) => string, string]> = [
  ["fleet", resolveFleetHost, "KANBAN_FLEET_HOST"],
  ["git-http", resolveConfiguredGitHost, "KANBAN_GIT_HTTP_HOST"],
];

describe.each(RESOLVERS)("%s bind host (#652)", (_name, resolve, envVar) => {
  it("defaults to LOOPBACK, not every interface (#753)", () => {
    expect(resolve({})).toBe("127.0.0.1");
  });

  it("binds every interface only when told to in so many words (#753)", () => {
    expect(resolve({ KANBAN_FLEET_INSECURE: "1" })).toBe("0.0.0.0");
    // Anything other than the exact opt-in stays closed — "true"/"yes" are not it.
    expect(resolve({ KANBAN_FLEET_INSECURE: "true" })).toBe("127.0.0.1");
    expect(resolve({ KANBAN_FLEET_INSECURE: "0" })).toBe("127.0.0.1");
  });

  it("prefers a named interface over the insecure opt-in", () => {
    expect(resolve({ [envVar]: "100.101.102.103", KANBAN_FLEET_INSECURE: "1" })).toBe("100.101.102.103");
  });

  it("treats blank and whitespace as unset rather than binding to nothing", () => {
    expect(resolve({ [envVar]: "" })).toBe("127.0.0.1");
    expect(resolve({ [envVar]: "   " })).toBe("127.0.0.1");
  });

  it("honours a configured address verbatim", () => {
    expect(resolve({ [envVar]: "100.101.102.103" })).toBe("100.101.102.103");
    expect(resolve({ [envVar]: "127.0.0.1" })).toBe("127.0.0.1");
    expect(resolve({ [envVar]: "board.tailnet.ts.net" })).toBe("board.tailnet.ts.net");
  });

  it("trims surrounding whitespace — a stray space in an env file must not become the host", () => {
    expect(resolve({ [envVar]: "  100.101.102.103  " })).toBe("100.101.102.103");
  });

  it("never falls back to 0.0.0.0 for a host it cannot vouch for", () => {
    // The failure mode to avoid: a value the resolver dislikes silently becoming
    // "every interface", i.e. WIDER than the operator asked for. An unresolvable host
    // must surface as a bind error at startup (already non-fatal and logged), not as a
    // quiet promotion to a wider exposure.
    expect(resolve({ [envVar]: "not a host" })).toBe("not a host");
  });
});

describe("the bind host reaches the operator (#652)", () => {
  it("worker instructions document both env vars and the reverse-proxy caveat", async () => {
    const { buildWorkerConnectSteps, renderWorkerConnectMarkdown } = await import("../cli/commands/worker.js");
    const md = renderWorkerConnectMarkdown(
      "http://board:3003",
      "tok",
      buildWorkerConnectSteps("http://board:3003", "tok"),
    );
    expect(md).toContain("KANBAN_FLEET_HOST");
    expect(md).toContain("KANBAN_GIT_HTTP_HOST");
    // The clone-hangs-with-no-cause failure is the one worth naming explicitly.
    expect(md).toMatch(/reverse proxy/i);
    expect(md).toMatch(/Funnel/);
  });
});
