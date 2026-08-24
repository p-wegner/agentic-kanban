// @gate:always-run — asserts on the TEXT of `fleet-worker-prompt.ts` and of the worker
// sources (the rejected-fix guard below), none of which this test imports, so a scoped
// run computed from the import graph would silently drop it.
// #847 and #851 — two doctor checks that reported a TRUE condition in a way that sent the
// operator somewhere useless, both found on the board's first real cross-machine dispatch.
//
// The shared defect is the verdict, not the observation:
//
//  #847 — the board used to bind the git transport ONLY lazily (a git dispatch called
//     `ensureGitHttpServer`, nothing else did, and `stopGitHttpServer` had no callers), so
//     "that port refuses" was the CORRECT state for the whole window since the last board
//     restart in which nothing was dispatched — on a `tsx watch` dev board, most of the
//     time. The check called it FAIL with a remedy naming two env vars that were already
//     right, and counted it into "N check(s) failed", so a healthy worker could not get a
//     clean doctor run. Since #855 a fleet-configured board (KANBAN_FLEET_PORT set) binds
//     the transport at STARTUP (#856 gave the listener a shutdown release), so there a
//     refused pinned port is a real fault again — but the worker cannot observe which kind
//     of board it probed, or whether an eager bind failed and degraded to lazy. The check
//     must therefore separate "routable host, nothing bound" (ECONNREFUSED -> unknown, with
//     BOTH readings spelled out) from a genuine routing/DNS fault (still fail) — the one
//     distinction a worker CAN observe, needing no knowledge of the board's configuration.
//     Weakening it into never-fails would be the opposite mistake, so both directions are
//     proven below against real sockets, not mocks.
//
//  #851 — a worker clones into `<work-root>/repos/<projectId>`, which by construction has
//     never been opened interactively, so Claude Code prints "this workspace has not been
//     trusted" and ignores that repo's permission settings on every first dispatch to a new
//     worker/project pair. Nothing reported it. It is NOT a security bypass — the worker
//     launches the agent with permissions bypassed and the PreToolUse hooks fire regardless
//     (verified from session transcript c63965b3: 65 PreToolUse events, zero denials, zero
//     prompts) — so the check reports it as `unknown`, never `fail`, and says which of the
//     two cases it found: allow-only settings (a confusing banner) or deny/ask rules that
//     really would be dropped. It must never WRITE `hasTrustDialogAccepted` — that would be
//     the board granting trust, on a machine it deliberately holds no credentials for, to
//     code it just pushed there.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkGitTransport,
  checkWorkerCheckoutTrust,
  errnoOfFetchFailure,
  readTrustedProjectPaths,
  resolveTrustConfigPaths,
  renderDoctorReport,
} from "../cli/commands/worker-doctor.js";

// ---------------------------------------------------------------------------------------
// #847 — the lazily-bound git transport
// ---------------------------------------------------------------------------------------

/** Listen on an OS-assigned port (never a guessed one — Windows reserved ranges EACCES). */
function listenEphemeral(handler: (status: number) => number): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createServer((_req, res) => {
      res.statusCode = handler(0);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, port: (server.address() as { port: number }).port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()));
}

describe("#847 — the git transport check does not call a not-yet-bound listener a fault", () => {
  it("PASSES against a real listener, 401 included (a listener answering IS the pass condition)", async () => {
    const { server, port } = await listenEphemeral(() => 401);
    try {
      const check = await checkGitTransport("http://127.0.0.1:19999", port);
      expect(check.status).toBe("pass");
      expect(check.detail).toContain("401");
      expect(check.detail).toContain("a listener is there and authenticating");
    } finally {
      await closeServer(server);
    }
  });

  it("BITE, direction 1: a routable host refusing the port is UNKNOWN, not FAIL — that is what a not-yet-bound board looks like", async () => {
    // Bind then close: the port is now provably free on a host that is provably routable,
    // which is exactly what a board whose git transport is not currently bound looks like
    // from a worker — a lazily-binding board (no fleet port, or pre-#855) before its first
    // git dispatch. The worker cannot tell that apart from a fleet-configured board whose
    // startup bind failed, so the verdict names BOTH readings instead of picking one.
    const { server, port } = await listenEphemeral(() => 200);
    await closeServer(server);

    const check = await checkGitTransport("http://127.0.0.1:19999", port);
    expect(check.status).toBe("unknown");
    expect(check.status).not.toBe("fail");
    expect(check.detail).toContain("ECONNREFUSED");
    // Both possibilities are spelled out: startup bind on fleet-configured boards (#855)...
    expect(check.detail).toContain("may not have bound the git transport yet");
    expect(check.detail).toContain("binds it at STARTUP");
    // ...and lazy bind on first dispatch everywhere else — including when it IS real.
    expect(check.detail).toContain("first git-transport dispatch");
    expect(check.detail).toContain("fleet-configured and freshly started");
    // The remedy names the env vars only for the case where they are actually suspect.
    expect(check.remedy).toContain("KANBAN_FLEET_PORT");
    expect(check.remedy).toContain("KANBAN_GIT_HTTP_PORT");
    expect(check.remedy).toContain("nothing to do until the first git dispatch");
  });

  it("BITE, direction 2: a host that cannot be reached at all is STILL a FAIL with the configuration remedy", async () => {
    // `.invalid` is reserved by RFC 2606 and can never resolve, so this is a genuine
    // routing/DNS fault rather than an unbound port — the case the check must keep biting on.
    const check = await checkGitTransport("http://board.host.invalid:19999", 3002);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("could not be reached");
    expect(check.remedy).toContain("KANBAN_GIT_HTTP_PORT");
    expect(check.remedy).toContain("KANBAN_GIT_HTTP_HOST");
  }, 20_000);

  it("a not-yet-bound transport no longer counts into 'N check(s) failed'", async () => {
    const { server, port } = await listenEphemeral(() => 200);
    await closeServer(server);
    const check = await checkGitTransport("http://127.0.0.1:19999", port);
    const rendered = renderDoctorReport({
      side: "worker",
      boardUrl: "http://127.0.0.1:19999",
      checks: [check],
      ok: check.status !== "fail",
    });
    expect(rendered).toContain("[UNKN]");
    expect(rendered).not.toContain("check(s) failed");
    expect(rendered).toContain("1 indeterminate");
  });

  it("still SKIPs when no --git-port was given, rather than guessing 3002", async () => {
    const check = await checkGitTransport("http://127.0.0.1:19999");
    expect(check.status).toBe("skip");
    expect(check.detail).toContain("no --git-port given");
  });

  it("the errno really is dug out of fetch's nested cause, AggregateError included", () => {
    const direct = new TypeError("fetch failed");
    (direct as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(errnoOfFetchFailure(direct)).toBe("ECONNREFUSED");

    const aggregated = new TypeError("fetch failed");
    (aggregated as { cause?: unknown }).cause = new AggregateError(
      [Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })],
      "all attempts failed",
    );
    expect(errnoOfFetchFailure(aggregated)).toBe("ENOTFOUND");

    // A cycle must not hang it, and a plain error yields nothing rather than a lie.
    const cyclic = new Error("boom") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(errnoOfFetchFailure(cyclic)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// #851 — worker checkout trust
// ---------------------------------------------------------------------------------------

describe("#851 — the doctor names untrusted worker checkouts instead of nothing reporting them", () => {
  let home: string;
  let workRoot: string;

  const PROJECT_ID = "d1c5d9c1-4897-4e1b-acc3-2aa96de04117";

  /** A worker clone with an optional `.claude/settings.json`. */
  function seedRepo(projectId: string, settings?: unknown): string {
    const dir = join(workRoot, "repos", projectId);
    mkdirSync(dir, { recursive: true });
    if (settings !== undefined) {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings), "utf8");
    }
    return dir;
  }

  function seedClaudeJson(projects: Record<string, unknown>): void {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }), "utf8");
  }

  beforeEach(() => {
    // `ak-` prefix, not a bare one: the fixture reaper only sweeps that namespace, so a dir
    // leaked by a crashed run is collected instead of accumulating forever (#840/#843).
    home = mkdtempSync(join(tmpdir(), "ak-doctor-home-"));
    workRoot = mkdtempSync(join(tmpdir(), "ak-doctor-work-"));
    // Hermetic env: checkWorkerCheckoutTrust resolves $CLAUDE_CONFIG_DIR from the LIVE
    // environment, so a runner launched from a profile session (CLAUDE_CONFIG_DIR set to a
    // real ~/.claude-* dir) had the check consult the operator's actual config instead of
    // this fixture — 4 of these tests failed on any profile machine and passed elsewhere.
    // Pin it to the fixture's config dir, which is what the tests already seed.
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  });

  it("SKIPs before the worker has cloned anything — there is nothing to trust yet", () => {
    const check = checkWorkerCheckoutTrust(workRoot, home);
    expect(check.status).toBe("skip");
    expect(check.detail).toContain("does not exist yet");
  });

  // A fleet worker ALWAYS has CLAUDE_CONFIG_DIR pinned, and Claude Code reads .claude.json from
  // there — not from the home directory. Reading only ~/.claude.json made the check name a file
  // the agent does not read: correct only while both files happened to agree, and a FALSE PASS
  // the moment an operator followed the remedy, with every dispatch still printing the banner.
  it("BITE: trust granted only in ~/.claude.json is NOT a pass when CLAUDE_CONFIG_DIR points elsewhere", () => {
    const dir = seedRepo(PROJECT_ID, { permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] } });
    const configDir = join(home, ".claude");
    mkdirSync(configDir, { recursive: true });
    // The operator followed the old remedy: granted in the HOME file only...
    seedClaudeJson({ [dir.replace(/\\/g, "/")]: { hasTrustDialogAccepted: true } });
    // ...while the file the agent actually reads still says nothing.
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ projects: {} }), "utf8");

    const check = checkWorkerCheckoutTrust(workRoot, home);
    expect(check.status).not.toBe("pass");
    expect(check.detail).toContain(dir);
    // The report must name every config it consulted, so the disagreement is visible.
    expect(check.detail).toContain(join(configDir, ".claude.json"));
    // The remedy names the config that actually lacks the entry, not a blanket "set it everywhere".
    expect(check.remedy).toContain(join(configDir, ".claude.json"));
    expect(check.remedy).toContain("has to agree");

    // Granting it in BOTH files — what actually makes the banner go away — passes.
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify({ projects: { [dir.replace(/\\/g, "/")]: { hasTrustDialogAccepted: true } } }),
      "utf8",
    );
    expect(checkWorkerCheckoutTrust(workRoot, home).status).toBe("pass");
  });

  // The mixed case is what an operator sees MIDWAY through the fix — granted in one config,
  // not yet the other — i.e. the check is most likely to be read exactly when a blanket
  // "missing from every config" claim would be false and would send them to edit files that
  // are already correct.
  it("names WHICH config lacks the entry instead of claiming they all do", () => {
    const dir = seedRepo(PROJECT_ID, { permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] } });
    const configDir = join(home, ".claude");
    mkdirSync(configDir, { recursive: true });
    const key = dir.replace(/\\/g, "/");
    // Granted in the home config...
    seedClaudeJson({ [key]: { hasTrustDialogAccepted: true } });
    // ...and absent from the one the agent reads.
    writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ projects: {} }), "utf8");

    const check = checkWorkerCheckoutTrust(workRoot, home);
    expect(check.status).toBe("unknown");

    const homeJson = join(home, ".claude.json");
    const agentJson = join(configDir, ".claude.json");
    // It must NOT claim the entry is missing everywhere — it is present in the home config.
    expect(check.detail).toContain(`are trusted in ${homeJson} but NOT in ${agentJson}`);
    // The remedy names ONLY the file that lacks it, never the one already correct.
    expect(check.remedy).toContain(agentJson);
    expect(check.remedy).not.toContain(`true in ${homeJson}`);
  });

  it("resolveTrustConfigPaths puts $CLAUDE_CONFIG_DIR first and never repeats a path", () => {
    const withVar = resolveTrustConfigPaths("/h", { CLAUDE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv);
    expect(withVar[0]).toBe(join("/cfg", ".claude.json"));
    expect(withVar).toContain(join("/h", ".claude.json"));

    const without = resolveTrustConfigPaths("/h", {} as NodeJS.ProcessEnv);
    expect(without).not.toContain(join("/cfg", ".claude.json"));
    expect(new Set(without).size).toBe(without.length);
  });

  it("BITE: an untrusted, allow-only checkout is reported as the cosmetic case it is", () => {
    const dir = seedRepo(PROJECT_ID, { permissions: { allow: ["Bash(git status:*)"], deny: [], ask: [] } });
    seedClaudeJson({});

    const check = checkWorkerCheckoutTrust(workRoot, home);
    // Reported — nothing reported it before.
    expect(check.detail).toContain(dir);
    expect(check.detail).toContain("hasTrustDialogAccepted");
    // ...but NOT as a fault: a doctor that exits non-zero over a banner is #847 again.
    expect(check.status).toBe("unknown");
    expect(check.status).not.toBe("fail");
    expect(check.detail).toContain("allow-only settings, so the effect is a confusing banner");
    // The remedy leaves the decision with the operator and names BOTH routes.
    expect(check.remedy).toContain("Claude Code interactively");
    expect(check.remedy).toContain("hasTrustDialogAccepted: true");
    expect(check.remedy).toContain("THIS MACHINE'S OPERATOR");
  });

  it("BITE: a checkout that DOES define deny/ask rules is reported as the case worth acting on", () => {
    seedRepo(PROJECT_ID, { permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"], ask: ["Bash(curl:*)"] } });
    seedClaudeJson({});

    const check = checkWorkerCheckoutTrust(workRoot, home);
    expect(check.status).toBe("unknown");
    expect(check.detail).toContain("2 deny/ask rule(s) here WOULD be dropped");
    expect(check.detail).not.toContain("allow-only settings");
  });

  it("BITE, the other direction: once the operator grants trust, it PASSES", () => {
    const dir = seedRepo(PROJECT_ID, { permissions: { allow: [] } });
    // Written the way Claude Code writes it: forward slashes, even on Windows.
    seedClaudeJson({ [dir.replace(/\\/g, "/")]: { hasTrustDialogAccepted: true } });

    const check = checkWorkerCheckoutTrust(workRoot, home);
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("are trusted");
  });

  it("a trust entry that is present but NOT accepted does not count as trusted", () => {
    const dir = seedRepo(PROJECT_ID, { permissions: { allow: [] } });
    seedClaudeJson({ [dir.replace(/\\/g, "/")]: { hasTrustDialogAccepted: false, allowedTools: [] } });

    expect(checkWorkerCheckoutTrust(workRoot, home).status).toBe("unknown");
  });

  it("reports only the untrusted ones when several projects are cloned here", () => {
    const trustedDir = seedRepo("trusted-project", { permissions: { allow: [] } });
    const untrustedDir = seedRepo("untrusted-project", { permissions: { allow: [] } });
    seedClaudeJson({ [trustedDir.replace(/\\/g, "/")]: { hasTrustDialogAccepted: true } });

    const check = checkWorkerCheckoutTrust(workRoot, home);
    expect(check.detail).toContain("1 of 2 worker checkout(s)");
    expect(check.detail).toContain(untrustedDir);
    expect(check.detail).not.toContain(trustedDir);
  });

  it("a corrupt ~/.claude.json reads as 'nothing trusted' rather than throwing", () => {
    seedRepo(PROJECT_ID);
    writeFileSync(join(home, ".claude.json"), "{ not json", "utf8");
    expect(readTrustedProjectPaths(join(home, ".claude.json")).size).toBe(0);
    expect(() => checkWorkerCheckoutTrust(workRoot, home)).not.toThrow();
    expect(checkWorkerCheckoutTrust(workRoot, home).status).toBe("unknown");
  });

  it("says so plainly when the checkout carries no .claude settings at all", () => {
    seedRepo(PROJECT_ID);
    seedClaudeJson({});
    expect(checkWorkerCheckoutTrust(workRoot, home).detail).toContain("no .claude settings found");
  });

  it("REJECTED FIX: the doctor never writes a trust flag of its own", () => {
    seedRepo(PROJECT_ID, { permissions: { allow: [] } });
    seedClaudeJson({});
    const before = readFileSync(join(home, ".claude.json"), "utf8");

    checkWorkerCheckoutTrust(workRoot, home);

    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before);
    expect(readTrustedProjectPaths(join(home, ".claude.json")).size).toBe(0);
    // And no source on the worker/doctor path may WRITE ~/.claude.json either — the tempting
    // one-liner routes around a security control, and it would make a run PERMITTED, never
    // CORRECT. (Prose naming the key is fine, and is how the remedy tells the operator what
    // to set; writing the file is not.)
    for (const rel of ["cli/commands/worker-doctor.ts", "worker/worker-repo.ts", "worker/worker-agent-runner.ts"]) {
      const file = resolve(__dirname, "..", rel);
      if (!existsSync(file)) continue;
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/(writeFileSync|appendFileSync|writeFile)\s*\([^)]*claude\.json/);
      expect(source).not.toMatch(/hasTrustDialogAccepted\s*=\s*true/);
    }
  });
});

describe("#851 — the runbook names the one-time trust step (acceptance criterion 3)", () => {
  it("the fleet-worker prompt tells the operator what the banner is and who grants trust", () => {
    const prompt = readFileSync(resolve(__dirname, "..", "services/fleet-worker-prompt.ts"), "utf8");
    expect(prompt).toContain("this workspace has not been trusted");
    expect(prompt).toContain("hasTrustDialogAccepted");
    expect(prompt).toContain("worker doctor");
    // It must not tell an operator the banner means their run was unsafe.
    expect(prompt).toContain("the PreToolUse hooks fire regardless");
  });
});
