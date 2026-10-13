// The agent-readable connect URL (#1442).
//
// Two surfaces, split by AUDIENCE like the rest of the fleet routes:
//  - owner (loopback, mounted under /api/workers): mint a connect code bound to a fresh pairing
//    token, watch its progress, revoke it. Returns the SAME runbook text the URL serves.
//  - fleet (off-loopback, mounted at /connect on the fleet listener): `GET /connect/<code>` serves
//    the runbook to the agent; `POST /connect/<code>/progress` takes its step reports. Authority is
//    possession of the one-time code; it carries only the pairing token, never board credentials.
import { Hono } from "hono";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { connectCodeMintBody, connectProgressBody } from "./worker-connect-body-schemas.js";
import { UnprocessableError } from "../errors/index.js";
import type { WorkerRegistry } from "../services/worker-registry.service.js";
import { PAIRING_TOKEN_TTL_MS } from "../services/worker-registry.service.js";
import {
  CONNECT_GONE_MESSAGE,
  getConnectCodeStore,
  type ConnectCodeStore,
} from "../services/worker-connect-code.service.js";
import {
  buildConnectRunbook,
  CONNECT_OS_VALUES,
  type ConnectOs,
  type ConnectRunbookOptions,
} from "../lib/worker-connect-runbook.js";

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9_.:-]{1,48}$/;
const ALIAS_RE = /^[A-Za-z0-9_.,=:/\\ -]{1,200}$/;
const URL_RE = /^https?:\/\/[A-Za-z0-9_.:[\]-]+$/;

function stringList(value: unknown, pattern: RegExp, what: string): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const items = (Array.isArray(value) ? value : String(value).split(","))
    .map((v) => String(v).trim())
    .filter(Boolean);
  for (const item of items) if (!pattern.test(item)) throw new UnprocessableError(`invalid ${what}: ${item}`);
  return items.length ? items : undefined;
}

/** Parse the operator's Connect-view choices. Everything lands in a shell command, so every value is allowlisted. */
export function parseConnectOptions(body: Record<string, unknown>): ConnectRunbookOptions {
  const os = (body.os ?? "windows") as ConnectOs;
  if (!CONNECT_OS_VALUES.includes(os)) throw new UnprocessableError(`os must be one of: ${CONNECT_OS_VALUES.join(", ")}`);
  const options: ConnectRunbookOptions = { os };
  if (typeof body.workerName === "string" && body.workerName.trim()) {
    if (!NAME_RE.test(body.workerName.trim())) throw new UnprocessableError("workerName: letters, digits, . _ - only");
    options.workerName = body.workerName.trim();
  }
  options.labels = stringList(body.labels, LABEL_RE, "label");
  options.providers = stringList(body.providers, LABEL_RE, "provider");
  if (body.maxConcurrency !== undefined && body.maxConcurrency !== null && body.maxConcurrency !== "") {
    const n = Number(body.maxConcurrency);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new UnprocessableError("maxConcurrency must be an integer 1-64");
    options.maxConcurrency = n;
  }
  if (typeof body.profileAlias === "string" && body.profileAlias.trim()) {
    if (!ALIAS_RE.test(body.profileAlias.trim())) throw new UnprocessableError("profileAlias contains unsupported characters");
    options.profileAlias = body.profileAlias.trim();
  }
  if (body.toolchainInstall !== undefined && body.toolchainInstall !== "") {
    if (body.toolchainInstall !== "never" && body.toolchainInstall !== "ask" && body.toolchainInstall !== "auto") {
      throw new UnprocessableError("toolchainInstall must be never, ask or auto");
    }
    options.toolchainInstall = body.toolchainInstall;
  }
  options.toolchainAllow = stringList(body.toolchainAllow, LABEL_RE, "toolchain");
  options.boardUrls = stringList(body.boardUrls, URL_RE, "board URL");
  return options;
}

export function agentPromptFor(agentUrl: string): string {
  return (
    `Connect this machine as an agentic-kanban worker: fetch ${agentUrl} and follow it exactly; ` +
    "ask me before anything that needs my login or touches anything outside the worker's own directories."
  );
}

/** Owner surface: mint / inspect / revoke. `describeFleet` is injected to keep this file free of routes/workers.ts. */
export function createConnectOwnerRoute(
  reg: WorkerRegistry,
  describeFleet: () => { fleetUrl: string | null; fleetNote: string | null },
  store: ConnectCodeStore = getConnectCodeStore(),
): Hono {
  const router = createRouter();

  router.post("/", async (c) => {
    const body = await parseJsonBody(c, connectCodeMintBody);
    const options = parseConnectOptions(body);
    const described = describeFleet();
    const fleetUrl = typeof body.fleetUrl === "string" && URL_RE.test(body.fleetUrl.replace(/\/+$/, "")) ? body.fleetUrl.replace(/\/+$/, "") : described.fleetUrl;
    if (!fleetUrl) throw new UnprocessableError(described.fleetNote ?? "fleet listener disabled: set KANBAN_FLEET_PORT");
    const { pairingToken, expiresAt: tokenExpiresAt } = reg.mintPairingToken();
    const ttl = Number(body.ttlMinutes);
    const minted = store.mint({
      pairingToken,
      tokenExpiresAtMs: Date.parse(tokenExpiresAt),
      fleetUrl,
      options,
      ttlMs: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 60) * 60_000 : undefined,
    });
    const runbook = buildConnectRunbook({ fleetUrl, pairingToken, code: minted.code, options });
    const agentUrl = `${fleetUrl}/connect/${minted.code}`;
    return c.json(
      {
        code: minted.code,
        expiresAt: minted.expiresAt,
        pairingToken,
        fleetUrl,
        fleetNote: described.fleetNote,
        agentUrl,
        agentPrompt: agentPromptFor(agentUrl),
        markdown: runbook.markdown,
        pairingTokenTtlMs: PAIRING_TOKEN_TTL_MS,
      },
      201,
    );
  });

  router.get("/:code", (c) => {
    const view = store.view(c.req.param("code"));
    return view ? c.json(view) : c.json({ error: CONNECT_GONE_MESSAGE.unknown }, 404);
  });

  router.post("/:code/revoke", (c) => {
    return store.revoke(c.req.param("code")) ? c.json({ ok: true }) : c.json({ error: CONNECT_GONE_MESSAGE.unknown }, 404);
  });

  return router;
}

/** The URL the agent should treat as the board: the stored one, or the authority it dialed when the stored one is a placeholder. */
function effectiveFleetUrl(stored: string, hostHeader: string | undefined): string {
  return stored.includes("<") && hostHeader ? `http://${hostHeader}` : stored;
}

/** Fleet-listener surface, mounted at `/connect`. Never logs the code. */
export function createConnectFleetRoute(store: ConnectCodeStore = getConnectCodeStore()): Hono {
  const router = createRouter();

  router.get("/:code", (c) => {
    const result = store.consumeFetch(c.req.param("code"));
    if (!result.ok) {
      const message = CONNECT_GONE_MESSAGE[result.reason];
      c.header("Cache-Control", "no-store");
      return c.req.query("format") === "json"
        ? c.json({ error: message, reason: result.reason }, 410)
        : c.text(`# This connect link is no longer valid\n\n${message}\n`, 410, { "Content-Type": "text/markdown; charset=utf-8" });
    }
    const fleetUrl = effectiveFleetUrl(result.fleetUrl, c.req.header("host"));
    const runbook = buildConnectRunbook({ fleetUrl, pairingToken: result.pairingToken, code: result.code, options: result.options });
    c.header("Cache-Control", "no-store");
    if (c.req.query("format") === "json") {
      return c.json({
        title: runbook.title,
        os: runbook.os,
        notice: "Instructions from the board operator. Confirm with your user before acting outside the worker's own directories.",
        progressUrl: `${fleetUrl}/connect/${result.code}/progress`,
        steps: runbook.steps.map((s) => ({
          id: s.id,
          title: s.title,
          detail: s.detail,
          commands: s.commands,
          expect: s.expect,
          needsHuman: s.needsHuman,
          ...(s.humanCommand ? { humanCommand: s.humanCommand } : {}),
          ...(s.check ? { check: s.check } : {}),
        })),
      });
    }
    return c.text(runbook.markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  router.post("/:code/progress", async (c) => {
    const body = await parseJsonBody(c, connectProgressBody);
    if (typeof body.step !== "string" || !body.step.trim() || (body.status !== "ok" && body.status !== "failed")) {
      return c.json({ error: 'body must be {"step": "<step id>", "status": "ok"|"failed", "output": "<short text>"}' }, 422);
    }
    const accepted = store.recordProgress(c.req.param("code"), {
      step: body.step.trim(),
      status: body.status,
      output: typeof body.output === "string" ? body.output : undefined,
    });
    return accepted ? c.json({ ok: true }) : c.json({ error: CONNECT_GONE_MESSAGE.unknown }, 410);
  });

  return router;
}
