/**
 * `worker doctor` — the connectivity self-test (#774, remaining #755 item 4).
 *
 * WHAT WAS MISSING: nothing checked the whole chain from the worker side. Runbook step 3 of
 * `docs/worker-fleet.md` is still a raw `curl -o /dev/null -w "%{http_code}"` against
 * `/health`, which proves one hop of five: it says nothing about whether the saved bearer
 * token still authenticates, whether the WebSocket upgrade survives whatever sits between
 * the two machines, whether the git transport port is reachable, or whether the provider CLI
 * on this machine is logged in — and that last one is the failure the board CANNOT diagnose,
 * because the board deliberately sends no credentials (decision 012).
 *
 * WHY IT IS TWO COMMANDS, NOT ONE. `docs/worker-fleet.md` §1 is explicit that a worker
 * machine "genuinely cannot ask the board how it looks from there": every owner route
 * (`GET /api/workers` included) is mounted only on the loopback board app, so a worker
 * pointed at the fleet port gets a 404 and pointed at the API port cannot connect at all.
 * A single command claiming to check both ends would therefore have to lie about one of
 * them. So:
 *
 *   - `worker doctor`        runs ON THE WORKER MACHINE  — the hops it can prove.
 *   - `worker doctor-board`  runs ON THE BOARD MACHINE   — what the board sees of the fleet.
 *
 * Each check reports `pass` / `fail` / `skip` / `unknown` and never dresses an
 * indeterminate result as a pass. `unknown` is a real outcome here: an OAuth login can be
 * checked by file presence but not proven without spending a request.
 *
 * `unknown` is ALSO where a true-but-not-faulty condition goes, and that distinction is
 * load-bearing (#847, #851): only `fail` flips `report.ok` and the process exit code, so a
 * condition an operator cannot or need not act on must never be one. A doctor that cannot
 * return clean on a healthy machine gets ignored, which costs more than the thing it warned
 * about. Reserve `fail` for a fault: something is wrong AND the remedy printed beside it
 * will fix it.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { defaultWorkerWorkRoot } from "../../worker/worker-repo.js";

export type CheckStatus = "pass" | "fail" | "skip" | "unknown";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a fail. Omitted when there is nothing actionable. */
  remedy?: string;
}

export interface DoctorReport {
  /** Which side of the fleet this report was produced from. */
  side: "worker" | "board";
  boardUrl: string;
  checks: DoctorCheck[];
  ok: boolean;
}

/**
 * The files that mean "this provider is logged in on THIS machine".
 *
 * Duplicated from the auth-rotation ring configs (`claude-subscription-ring.ts`
 * `authFiles: [".credentials.json", "settings.json"]`, `codex-license-ring.ts`
 * `authFiles: ["auth.json"]`) rather than imported, because those modules reach the
 * database and this file is part of the standalone worker binary, which "never opens or
 * creates a database" (docs/worker-fleet.md §3). The duplication is PINNED:
 * `worker-doctor.test.ts` (provider auth parity) reads those two source files and fails
 * if either list changes without this one.
 *
 * `dir` is the home-relative DEFAULT only (#875): a provider whose login is relocated
 * wholesale by an env var (claude → `CLAUDE_CONFIG_DIR`, codex → `CODEX_HOME` — the same
 * levers the rotation rings and the Windows service pin) resolves through its own rule in
 * `worker-doctor-provider-auth.ts`, and the env-named directory then holds the files
 * DIRECTLY — this fragment stops applying there.
 */
export const PROVIDER_AUTH_FILES: Record<string, { dir: string; files: string[]; loginCommand: string }> = {
  claude: { dir: ".claude", files: [".credentials.json", "settings.json"], loginCommand: "claude /login" },
  codex: { dir: ".codex", files: ["auth.json"], loginCommand: "codex login" },
};

function ok(name: string, detail: string): DoctorCheck {
  return { name, status: "pass", detail };
}
function bad(name: string, detail: string, remedy?: string): DoctorCheck {
  return remedy === undefined ? { name, status: "fail", detail } : { name, status: "fail", detail, remedy };
}

/** Run a command and report whether it exists and what it printed. Never throws. */
export function probeCommand(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ found: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      // windowsHide: this must never flash a console window — the board's own rule, and a
      // doctor run from a Windows scheduled task would otherwise pop one per provider.
      { timeout: timeoutMs, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ found: false, code: null, output });
          return;
        }
        const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
        resolve({ found: true, code, output });
      },
    );
  });
}

/**
 * The OS-level errno behind a failed `fetch`, or null.
 *
 * `fetch` reports every transport failure as the same useless `TypeError: fetch failed`; the
 * thing that actually distinguishes "routable host, nothing bound on that port" from "cannot
 * get there at all" is the errno hanging off `.cause` — and when a hostname resolves to
 * several addresses undici raises an `AggregateError` whose `errors[]` carry it instead.
 * #847 turned on this distinction, so it is dug out rather than flattened into a message.
 */
export function errnoOfFetchFailure(err: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (e: unknown): string | null => {
    if (!e || typeof e !== "object" || seen.has(e)) return null;
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const aggregate = (e as { errors?: unknown }).errors;
    if (Array.isArray(aggregate)) {
      for (const inner of aggregate) {
        const found = walk(inner);
        if (found) return found;
      }
    }
    return walk((e as { cause?: unknown }).cause);
  };
  return walk(err);
}

/** Any HTTP answer proves the listener is up; only a transport error is a failure. */
async function probeHttp(
  url: string,
  init?: RequestInit,
): Promise<{ reachable: boolean; status?: number; error?: string; errno?: string }> {
  try {
    const res = await fetch(url, init);
    return { reachable: true, status: res.status };
  } catch (err) {
    const errno = errnoOfFetchFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      reachable: false,
      // `fetch failed` on its own has never told anyone anything; append the errno when
      // there is one so the report names the actual condition.
      error: errno ? `${message} (${errno})` : message,
      ...(errno ? { errno } : {}),
    };
  }
}

interface SavedIdentity {
  workerId: string;
  workerToken: string;
  name: string;
}

/**
 * The pairing this machine already holds for `boardUrl`, from the worker state file.
 *
 * Read directly rather than through the daemon so the doctor can run while the daemon is
 * NOT running — which is the case an operator reaches for it in.
 */
export function readSavedIdentity(stateFile: string, boardUrl: string): SavedIdentity | null {
  try {
    if (!existsSync(stateFile)) return null;
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      boards?: Record<string, SavedIdentity>;
    };
    const entry = parsed.boards?.[boardUrl.replace(/\/+$/, "")];
    return entry?.workerId && entry.workerToken ? entry : null;
  } catch {
    return null;
  }
}

/** Check 1 — is the fleet listener answering at all? */
async function checkReachable(boardUrl: string): Promise<DoctorCheck> {
  // The fleet listener answers `/health` AND `/api/health` unauthenticated on purpose, so
  // one probe works against either port (docs §1).
  const probe = await probeHttp(`${boardUrl}/health`);
  if (!probe.reachable) {
    return bad(
      "fleet port reachable",
      `${boardUrl}/health could not be reached: ${probe.error}`,
      "Check the host/port, that KANBAN_FLEET_PORT is set on the board, and that KANBAN_FLEET_HOST " +
        "names an interface this machine can route to (absent = every interface).",
    );
  }
  return ok("fleet port reachable", `${boardUrl}/health answered ${probe.status}`);
}

/** Check 2 — does the pairing this machine holds still authenticate? */
async function checkHeartbeat(boardUrl: string, identity: SavedIdentity | null): Promise<DoctorCheck> {
  if (!identity) {
    return {
      name: "saved pairing authenticates",
      status: "skip",
      detail: "no pairing saved for this board — nothing to authenticate yet",
      remedy: `Mint a token on the board (agentic-kanban worker pair) and run: worker start --board ${boardUrl} --token <token>`,
    };
  }
  const probe = await probeHttp(`${boardUrl}/api/workers/${identity.workerId}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${identity.workerToken}` },
    // No `protocolVersion` key: the registry treats its ABSENCE as "declared nothing" and
    // skips the version judgement, so a doctor run can never be refused for skew it is not
    // testing. Skew is what check 3 (the socket) and the board's own logs surface.
    body: JSON.stringify({}),
  });
  if (!probe.reachable) {
    return bad("saved pairing authenticates", `heartbeat could not be reached: ${probe.error}`);
  }
  if (probe.status === 401) {
    return bad(
      "saved pairing authenticates",
      `the board rejected this machine's bearer token (401) for worker ${identity.workerId}`,
      "The worker was revoked, or the board's DB was replaced. Revoke it on the board and re-pair with a fresh --token.",
    );
  }
  if (probe.status === 409) {
    return bad(
      "saved pairing authenticates",
      "protocol version mismatch (409) — the token is fine, the build is not",
      "Upgrade this machine's agentic-kanban worker to match the board's protocol version.",
    );
  }
  if (probe.status !== 200) {
    return bad("saved pairing authenticates", `heartbeat answered ${probe.status}, expected 200`);
  }
  return ok("saved pairing authenticates", `worker ${identity.workerId} heartbeat accepted (200)`);
}

/**
 * Check 3 — does the WebSocket upgrade survive whatever sits between the machines?
 *
 * The one hop `curl /health` cannot cover, and the one most likely to be broken by
 * something in the middle: a proxy that does not forward `Upgrade`, or a tunnel that
 * answers HTTP fine and drops the socket.
 */
export function checkWebSocket(
  boardUrl: string,
  identity: SavedIdentity | null,
  timeoutMs = 10_000,
): Promise<DoctorCheck> {
  if (!identity) {
    return Promise.resolve({
      name: "websocket upgrade",
      status: "skip",
      detail: "no pairing saved — the socket is authenticated per worker, so there is nothing to open",
    });
  }
  const wsUrl = `${boardUrl.replace(/^http/, "ws")}/ws/workers/${identity.workerId}`;
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${identity.workerToken}` } });
    const finish = (check: DoctorCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Close it immediately: the board evicts a second connection for the same workerId,
      // so a doctor run that LEFT its socket open would knock the real daemon offline.
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      resolve(check);
    };
    const timer = setTimeout(
      () =>
        finish(
          bad(
            "websocket upgrade",
            `no open within ${timeoutMs} ms at ${wsUrl}`,
            "Something between the machines is not forwarding the Upgrade header. A path-based reverse " +
              "proxy in front of the fleet port is the usual cause (docs/worker-fleet.md §8).",
          ),
        ),
      timeoutMs,
    );
    socket.on("open", () => finish(ok("websocket upgrade", `${wsUrl} accepted the upgrade`)));
    socket.on("error", (err: Error) =>
      finish(bad("websocket upgrade", `${wsUrl} failed: ${err.message}`)),
    );
    socket.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) =>
      finish(
        bad(
          "websocket upgrade",
          `${wsUrl} answered HTTP ${res.statusCode ?? "?"} instead of upgrading`,
          res.statusCode === 401
            ? "The bearer token was rejected — re-pair this machine."
            : "The fleet listener does not serve this path; check the port.",
        ),
      ),
    );
  });
}

/**
 * Check 4 — is the git transport reachable?
 *
 * Only probeable when the operator names the port: the worker learns the git port from the
 * BOARD, per assignment (`composeGitUrl`), so a doctor with no assignment in hand does not
 * know it. Reporting `skip` with the reason beats guessing 3002 and calling a wrong answer
 * a failure.
 *
 * And a REACHABLE port is not the same as a BOUND one (#847). Since #855 the board binds
 * the transport at STARTUP when a fleet is configured (KANBAN_FLEET_PORT set) — on such a
 * board a refused pinned port is a genuine fault again. But a board WITHOUT a fleet port
 * (or a pre-#855 build) still binds lazily on its first git-transport dispatch, and the
 * worker cannot observe which kind of board it is probing, nor whether an eager bind
 * failed and the board degraded to lazy. So the honest verdict for "connection refused"
 * stays `unknown`, never `fail`, with BOTH readings spelled out. See
 * {@link LAZY_BIND_ERRNOS}.
 */
/**
 * The errnos that mean "this machine CAN reach that host, and that port simply has no
 * listener" — i.e. exactly what a not-yet-lazily-bound git transport looks like from here.
 * Anything outside this set (ENOTFOUND, ETIMEDOUT, EHOSTUNREACH, ECONNRESET, EAI_AGAIN, a
 * TLS error, ...) is a real routing/config fault and stays a FAIL.
 */
const LAZY_BIND_ERRNOS = new Set(["ECONNREFUSED"]);

// This is the REPORTING half of #847. The structural half landed as #855: a fleet-configured
// board binds the transport at startup and keeps it bound (released only by shutdown, #856),
// so the listener no longer depends on dispatch history. This branch stays — a board without
// a fleet port legitimately has no listener until its first git dispatch, an older board
// binds lazily in every case, and an eager bind can fail and degrade to lazy — but on a
// current fleet-configured board it stops being the common case.

export async function checkGitTransport(boardUrl: string, gitPort?: number): Promise<DoctorCheck> {
  if (!gitPort) {
    return {
      name: "git transport reachable",
      status: "skip",
      detail: "no --git-port given; the worker learns this port from the board per assignment, so it cannot be inferred here",
      remedy: "Pass --git-port <KANBAN_GIT_HTTP_PORT> to check it.",
    };
  }
  // Same hostname, substituted port — exactly how the worker composes a clone URL, so this
  // probe fails for the same reasons a real clone would (including the path-prefix trap:
  // any prefix in --board is discarded here too).
  let base: URL;
  try {
    base = new URL(boardUrl);
  } catch {
    return bad("git transport reachable", `--board is not a URL: ${boardUrl}`);
  }
  const url = `${base.protocol}//${base.hostname}:${gitPort}/git/`;
  const probe = await probeHttp(url);
  if (!probe.reachable) {
    if (probe.errno && LAZY_BIND_ERRNOS.has(probe.errno)) {
      // #847. What the errno proves is exactly "the host is routable and that port has no
      // listener" — and since #855 that has TWO honest readings the worker cannot tell
      // apart. A fleet-configured board (KANBAN_FLEET_PORT set) binds the transport at
      // STARTUP and keeps it bound, so there a refused pinned port is a real fault (a
      // failed eager bind, or the two env vars genuinely wrong). A board without a fleet
      // port, or a pre-#855 build, binds lazily on its first git-transport dispatch, so
      // there a refused port is the EXPECTED pre-dispatch state — the condition that used
      // to produce an operator's FAIL -> PASS -> FAIL across three runs with zero
      // configuration changed. Whether the probed board eagerly bound, and whether it has
      // dispatched since its last restart, are both invisible from this machine, so the
      // verdict is keyed on the one observable — the errno — and stays `unknown` rather
      // than resolving the ambiguity as the alarming one: `fail` here meant a healthy
      // pre-dispatch worker could never get a clean doctor run.
      return {
        name: "git transport reachable",
        status: "unknown",
        detail:
          `${url} is routable but nothing is listening on port ${gitPort} (${probe.errno}). ` +
          "The board may not have bound the git transport yet: since #855 a fleet-configured " +
          "board (KANBAN_FLEET_PORT set) binds it at STARTUP, while a board without a fleet " +
          "port — or an older board in every case — binds it on its first git-transport " +
          "dispatch. This machine cannot tell which kind of board it probed, so this is not a " +
          "verdict — but if the board IS fleet-configured and freshly started, a refused port " +
          "here is a real failure.",
        remedy:
          "If the board is fleet-configured (KANBAN_FLEET_PORT set) and has finished starting, " +
          "treat this as real: check KANBAN_GIT_HTTP_PORT on the board, that KANBAN_GIT_HTTP_HOST " +
          "names an interface this machine can route to, and the board's startup log for a " +
          "'[git-http] eager startup bind failed' warning. On a board that binds lazily (no fleet " +
          "port configured, or a pre-#855 build), nothing to do until the first git dispatch — " +
          "that is what a healthy fleet looks like from here. Never put a path-based reverse " +
          "proxy in front of it (docs §8).",
      };
    }
    // Everything else — DNS failure, timeout, no route — is a fault regardless of whether
    // the transport has bound yet, so it stays a FAIL with the configuration remedy.
    return bad(
      "git transport reachable",
      `${url} could not be reached: ${probe.error}`,
      "Set KANBAN_GIT_HTTP_PORT on the board and make sure KANBAN_GIT_HTTP_HOST names an interface " +
        "this machine can route to. Never put a path-based reverse proxy in front of it (docs §8).",
    );
  }
  // 401/404 are GOOD news: the listener is up and refusing an unauthenticated, project-less
  // request, which is exactly what it should do. Only a transport error is a failure.
  return ok("git transport reachable", `${url} answered ${probe.status} (a listener is there and authenticating)`);
}

// #851's worker-checkout-trust check (check 6) lives in its own module: this file sits at
// the god-module gate's 20-declaration ceiling (#889) — same reason as the two imports below.
import { checkWorkerCheckoutTrust } from "./worker-doctor-checkout-trust.js";
export {
  checkWorkerCheckoutTrust,
  resolveTrustConfigPaths,
  readTrustedProjectPaths,
} from "./worker-doctor-checkout-trust.js";

/** Check 5 — git on PATH. The transport is useless without it. */
async function checkGit(): Promise<DoctorCheck> {
  const probe = await probeCommand("git", ["--version"]);
  if (!probe.found) return bad("git on PATH", "git is not on this machine's PATH", "Install git and re-open the shell.");
  return ok("git on PATH", probe.output.split("\n")[0] ?? "git present");
}

// #860's Node-floor check lives in its own module: this file sits exactly at the
// god-module gate's 20-declaration ceiling (#889), and the check pushed it to 21.
import { checkNodeVersion } from "./worker-doctor-node-check.js";
export { MIN_SUPPORTED_NODE_MAJOR, checkNodeVersion } from "./worker-doctor-node-check.js";
// #875's env-aware auth-dir resolution lives in its own module for the same reason.
import { resolveProviderAuthDir } from "./worker-doctor-provider-auth.js";

/**
 * Check 7 — the provider CLI, installed AND logged in.
 *
 * The board cannot diagnose this at all: a worker authenticates the agent with its OWN
 * local login and the board sends no credentials (decision 012), so "installed but not
 * logged in" looks to the board exactly like a healthy worker that keeps failing its
 * sessions. `installed` is proven by running the binary; `logged in` is inferred from the
 * auth files the board's own rotation ring uses, and reported as `unknown` rather than
 * `pass` when they are absent but an API key may be in the environment instead.
 */
export async function checkProvider(
  provider: string,
  home: string = homedir(),
  // #875: injectable so tests stay hermetic (the live env on a profile machine carries a
  // real CLAUDE_CONFIG_DIR — the exact condition this parameter exists to control).
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const version = await probeCommand(provider, ["--version"]);
  if (!version.found) {
    checks.push(
      bad(
        `${provider} CLI installed`,
        `'${provider}' is not on this machine's PATH`,
        `Install the ${provider} CLI here. The board never ships it — a worker runs the provider locally.`,
      ),
    );
    return checks;
  }
  checks.push(ok(`${provider} CLI installed`, version.output.split("\n")[0] ?? "present"));

  const auth = PROVIDER_AUTH_FILES[provider];
  if (!auth) {
    checks.push({
      name: `${provider} logged in`,
      status: "unknown",
      detail: `no known auth-file location for '${provider}', so this cannot be checked offline`,
      remedy: `Run a one-shot ${provider} command here and confirm it does not prompt for a login.`,
    });
    return checks;
  }
  // #875: the login can be relocated wholesale by an env var (CLAUDE_CONFIG_DIR /
  // CODEX_HOME) — which is how a fleet worker is actually configured — so the consulted
  // directory comes from the provider's own rule, and the output ALWAYS names both the
  // path and what selected it: a check that inspects ~/.claude while the dispatched agent
  // authenticates from $CLAUDE_CONFIG_DIR is wrong precisely on the machines it is for.
  const resolved = resolveProviderAuthDir(provider, auth.dir, home, env);
  const dir = resolved.dir;
  const present = auth.files.filter((f) => existsSync(join(dir, f)));
  if (present.length > 0) {
    checks.push(ok(`${provider} logged in`, `${dir} holds ${present.join(", ")} (consulted via ${resolved.source})`));
    return checks;
  }
  checks.push({
    name: `${provider} logged in`,
    // NOT a fail: an API key in the environment is a legitimate second way to be
    // authenticated, and this check cannot see one. Saying "fail" would send an operator
    // chasing a login that is already fine.
    status: "unknown",
    detail:
      `none of ${auth.files.join(", ")} found in ${dir} (consulted via ${resolved.source}) — ` +
      `either not logged in, or authenticated by an env API key this check cannot see`,
    remedy: `If sessions fail with an auth error, run: ${auth.loginCommand}`,
  });
  return checks;
}

/**
 * Whether `checkProvider`'s checks amount to PROOF this machine can authenticate as
 * `provider` — not merely "not disproved" (#895).
 *
 * A doctor REPORT is read by a human who can weigh `unknown` (files absent, but an env API
 * key might be set) against what they know about the machine. Advertising a provider to the
 * board is an UNATTENDED claim the board will act on by dispatching real work, so it needs
 * the stronger bar: every check for this provider must be `pass`. This is what would have
 * caught the live #895 repro — a worker whose `claude` login had lapsed reported `unknown`
 * (a real, non-actionable possibility for a doctor report), and `unknown` must not be read as
 * "fine" by the thing that decides what gets dispatched.
 */
export async function attestProviderAuth(
  provider: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ attested: boolean; checks: DoctorCheck[] }> {
  const checks = await checkProvider(provider, home, env);
  return { attested: checks.length > 0 && checks.every((c) => c.status === "pass"), checks };
}

export interface WorkerDoctorOptions {
  boardUrl: string;
  stateFile: string;
  providers: string[];
  gitPort?: number;
  home?: string;
  timeoutMs?: number;
  /** Worker work root, for the checkout-trust check (#851). Defaults to ~/.agentic-kanban/worker. */
  workRoot?: string;
}

/** The worker-machine half. Runs every hop this side can actually prove. */
export async function runWorkerDoctor(opts: WorkerDoctorOptions): Promise<DoctorReport> {
  const boardUrl = opts.boardUrl.replace(/\/+$/, "");
  const identity = readSavedIdentity(opts.stateFile, boardUrl);
  const checks: DoctorCheck[] = [];
  checks.push(await checkReachable(boardUrl));
  checks.push(await checkHeartbeat(boardUrl, identity));
  checks.push(await checkWebSocket(boardUrl, identity, opts.timeoutMs));
  checks.push(await checkGitTransport(boardUrl, opts.gitPort));
  checks.push(await checkGit());
  checks.push(checkNodeVersion());
  checks.push(checkWorkerCheckoutTrust(opts.workRoot ?? defaultWorkerWorkRoot(), opts.home ?? homedir()));
  for (const provider of opts.providers) {
    checks.push(...(await checkProvider(provider, opts.home)));
  }
  return { side: "worker", boardUrl, checks, ok: checks.every((c) => c.status !== "fail") };
}

/** One row of the board's own fleet view, as `GET /api/workers` now answers it. */
interface BoardWorkerRow {
  id: string;
  name: string;
  effectiveStatus: string;
  connected: boolean;
  load: number;
  maxConcurrency: number;
  freeSlots: number;
  eligible: boolean;
  ineligibleReason: string | null;
  workerVersion?: string;
}

/**
 * The board-machine half: what the board SEES. Runs only where the owner routes are
 * mounted, which is why it is a separate command (docs §1).
 */
export async function runBoardDoctor(opts: {
  boardUrl: string;
  projectId?: string;
  provider?: string;
}): Promise<DoctorReport> {
  const boardUrl = opts.boardUrl.replace(/\/+$/, "");
  const checks: DoctorCheck[] = [];
  const params = new URLSearchParams();
  if (opts.projectId) params.set("projectId", opts.projectId);
  if (opts.provider) params.set("provider", opts.provider);
  const query = params.toString();

  interface BoardFleetView {
    workers?: BoardWorkerRow[];
    fleet?: { freeSlots: number; eligible: number; registered: number };
  }
  let body: BoardFleetView | null = null;
  try {
    const res = await fetch(`${boardUrl}/api/workers${query ? `?${query}` : ""}`);
    if (!res.ok) {
      checks.push(
        bad(
          "owner surface reachable",
          `GET /api/workers answered ${res.status}`,
          res.status === 404
            ? "This looks like the FLEET port. doctor-board must run on the board machine against its API port (default 3001)."
            : "Is the board running?",
        ),
      );
      return { side: "board", boardUrl, checks, ok: false };
    }
    body = (await res.json()) as BoardFleetView;
    checks.push(ok("owner surface reachable", `GET /api/workers answered 200 at ${boardUrl}`));
  } catch (err) {
    checks.push(
      bad(
        "owner surface reachable",
        `could not reach ${boardUrl}/api/workers: ${err instanceof Error ? err.message : String(err)}`,
        "Run this ON THE BOARD MACHINE — the owner routes are mounted only on the loopback app.",
      ),
    );
    return { side: "board", boardUrl, checks, ok: false };
  }

  const workers = body?.workers ?? [];
  if (workers.length === 0) {
    checks.push({
      name: "workers registered",
      status: "fail",
      detail: "no worker is registered with this board",
      remedy: "agentic-kanban worker pair, then run `worker start --token <token>` on the other machine.",
    });
    return { side: "board", boardUrl, checks, ok: false };
  }
  checks.push(ok("workers registered", `${workers.length} worker(s) registered`));

  for (const w of workers) {
    if (w.effectiveStatus !== "online") {
      checks.push(
        bad(
          `worker ${w.name}`,
          `effectiveStatus is ${w.effectiveStatus} — the last heartbeat is older than 90 s, or it is draining`,
          "Run `worker doctor` on that machine; if the daemon is up, the fleet port is what to check.",
        ),
      );
      continue;
    }
    if (!w.connected) {
      // The single most confusing fleet state, and one of the five eligibility failures
      // that all printed the same "no eligible worker" before #755.
      checks.push(
        bad(
          `worker ${w.name}`,
          "heartbeat is fresh but the board holds no WebSocket for it — it will never be picked",
          "Something between the machines is dropping the socket while letting HTTP through: run " +
            "`worker doctor` there and read the websocket-upgrade check.",
        ),
      );
      continue;
    }
    if (!w.eligible) {
      checks.push({
        name: `worker ${w.name}`,
        status: "fail",
        detail: w.ineligibleReason ?? "not a candidate for the resolved provider/labels",
        remedy: "worker explain <issue> names the check that decided and the preference to change.",
      });
      continue;
    }
    checks.push(ok(`worker ${w.name}`, `online, connected, eligible — ${w.freeSlots}/${w.maxConcurrency} slots free`));
  }

  if (body?.fleet) {
    const { freeSlots, eligible, registered } = body.fleet;
    checks.push(
      freeSlots > 0
        ? ok("free capacity", `${freeSlots} free slot(s) across ${eligible} eligible of ${registered} worker(s)`)
        : bad(
            "free capacity",
            `0 free slots (${eligible} eligible of ${registered} registered) — every slot is in use`,
            "Nothing is broken; a strict-dispatch project will hold until a slot frees up.",
          ),
    );
  }

  return { side: "board", boardUrl, checks, ok: checks.every((c) => c.status !== "fail") };
}

const ICONS: Record<CheckStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", unknown: "UNKN" };

/** Human-readable report. Deliberately plain text — this gets pasted into an issue. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    report.side === "worker"
      ? `Worker-side self-test against ${report.boardUrl}`
      : `Board-side fleet check at ${report.boardUrl}`,
  );
  lines.push("");
  for (const c of report.checks) {
    lines.push(`  [${ICONS[c.status]}] ${c.name}: ${c.detail}`);
    if (c.remedy && c.status !== "pass") lines.push(`         -> ${c.remedy}`);
  }
  lines.push("");
  const failed = report.checks.filter((c) => c.status === "fail").length;
  const unknown = report.checks.filter((c) => c.status === "unknown").length;
  lines.push(
    failed === 0
      ? `All ${report.checks.length} checks passed or were skipped${unknown > 0 ? ` (${unknown} indeterminate — see above)` : ""}.`
      : `${failed} check(s) failed.`,
  );
  if (report.side === "worker") {
    lines.push(
      "This half cannot see how the board views this machine — the owner routes are loopback-only " +
        "(docs/worker-fleet.md §1). Run `agentic-kanban worker doctor-board` on the board for that half.",
    );
  }
  return lines.join("\n");
}
