import { ConflictError, UnprocessableError } from "../errors/index.js";
import type { Context, Hono } from "hono";
import { createRouter } from "../middleware/create-router.js";
import { parseOptionalJsonBody } from "../middleware/parse-body.js";
import { extractBearer } from "../lib/bearer-token.js";
import type { Database } from "../db/index.js";
import {
  getWorkerRegistry,
  PROTOCOL_MISMATCH_PREFIX,
  type WorkerRegistry,
  type WorkerStatus,
} from "../services/worker-registry.service.js";
import { parseWorkerCapabilities } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  listIncomingRefs,
  landIncomingRef,
  discardIncomingRef,
} from "../services/worker-incoming-refs.service.js";
import {
  explainIssuePlacement,
  explainPlacement,
  listSessionPlacements,
} from "../services/placement-explain.service.js";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";
import type { ProviderName } from "../services/agent-provider.js";

function bearerFrom(c: Context): string | null {
  return extractBearer(c.req.header("authorization"));
}

/**
 * Worker-fleet control plane (epic #1, phase 1a #3).
 *
 * Two trust zones on one router:
 *  - Owner surface (pairing-token mint, list, revoke) rides the board's
 *    loopback trust model like every other REST route.
 *  - Worker surface (register, heartbeat) is called by remote machines and
 *    authenticates per request — pairing token at registration, per-worker
 *    bearer token afterwards — so it stays safe when the listener is opened
 *    beyond loopback for the fleet.
 */
/**
 * Owner-only endpoints. These stay on the LOOPBACK app forever: minting a
 * pairing token, listing the fleet and revoking a worker are administrative
 * actions with no credential of their own — they ride the board's
 * "only reachable from this machine" trust, exactly like the rest of /api.
 */
function registerOwnerRoutes(router: Hono, reg: WorkerRegistry, database: Database): void {
  router.post("/pairing-token", (c) => c.json(reg.mintPairingToken(), 201));

  router.get("/", async (c) => {
    return c.json({ workers: await reg.listWorkersView() });
  });

  // #752 — the incoming-ref staging namespace, made observable and reclaimable.
  // Owner-only for the same reason the rest of this block is: landing a ref moves
  // a branch, and discarding one drops commits. Never on the fleet listener.
  router.get("/incoming", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    return c.json(await listIncomingRefs(database, { projectId }));
  });

  router.post("/incoming/land", async (c) => {
    const body = await parseOptionalJsonBody<{ projectId?: string; branch?: string }>(c);
    if (!body.projectId || !body.branch) throw new UnprocessableError("projectId and branch are required");
    const result = await landIncomingRef(body.projectId, body.branch, database);
    if (!result.ok) throw new ConflictError(`${result.error} (outcome: ${JSON.stringify(result.outcome)})`);
    return c.json({ ok: true, outcome: result.outcome });
  });

  router.post("/incoming/discard", async (c) => {
    const body = await parseOptionalJsonBody<{ projectId?: string; branch?: string; force?: boolean }>(c);
    if (!body.projectId || !body.branch) throw new UnprocessableError("projectId and branch are required");
    const result = await discardIncomingRef(body.projectId, body.branch, database, { force: body.force === true });
    // `error` is optional on the result type, so the inline body this replaced could answer a
    // bare `{}` on refusal. A refusal always says why now.
    if (!result.ok) throw new ConflictError(result.error ?? `discard refused for ${body.branch}`);
    return c.json({ ok: true, sha: result.sha });
  });

  // #755 — "why was #N not dispatched?" Answered by walking the SAME ordered chain
  // `resolveWorkerPlacement` applies, against live state, and cross-checking the
  // result against the resolver itself. Owner-only like the rest of this block: it
  // reports preference values and the whole fleet's shape.
  router.get("/explain", async (c) => {
    const projectId = c.req.query("projectId") || (await getPreferenceValue("activeProjectId", database));
    if (!projectId) throw new UnprocessableError("projectId is required (and no active project is set)");
    const provider = c.req.query("provider") as ProviderName | undefined;
    const issueParam = c.req.query("issue");
    if (issueParam === undefined) {
      // Project-level: "would anything dispatch right now?" — no issue, so the
      // branch-dependent check is evaluated against the branch the caller names.
      const explanation = await explainPlacement({
        database,
        projectId,
        providerName: provider ?? "claude",
        branch: c.req.query("branch") || undefined,
      });
      return c.json({ projectId, explanation });
    }
    const issueNumber = Number(issueParam);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new UnprocessableError(`issue must be a positive integer, got ${JSON.stringify(issueParam)}`);
    }
    const report = await explainIssuePlacement({ database, projectId, issueNumber, providerName: provider });
    if ("error" in report) return c.json(report, 404);
    return c.json(report);
  });

  // #755 — per-session placement. `sessions.worker_id` has been written since epic #1
  // and read by nothing, so "which machine ran this" was unanswerable after the fact.
  router.get("/placements", async (c) => {
    const limitParam = Number(c.req.query("limit"));
    return c.json({
      placements: await listSessionPlacements({
        database,
        projectId: c.req.query("projectId") || undefined,
        issueId: c.req.query("issueId") || undefined,
        workspaceId: c.req.query("workspaceId") || undefined,
        workerId: c.req.query("workerId") || undefined,
        remoteOnly: c.req.query("remoteOnly") === "true",
        limit: Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : undefined,
      }),
    });
  });

  router.delete("/:id", async (c) => {
    const ok = await reg.revokeWorker(c.req.param("id"));
    if (!ok) return c.json({ error: "worker not found" }, 404);
    return c.json({ ok: true });
  });
}

/**
 * Worker-called endpoints. Every one authenticates for itself — a pairing token
 * at registration, the per-worker bearer token afterwards — so this is the ONLY
 * HTTP surface safe to expose off-loopback, and the fleet listener serves
 * exactly this and nothing else.
 */
function registerWorkerFacingRoutes(router: Hono, reg: WorkerRegistry): void {
  router.post("/register", async (c) => {
    const body = await parseOptionalJsonBody<{
      pairingToken?: string;
      name?: string;
      os?: string;
      arch?: string;
      labels?: string[];
      providers?: string[];
      maxConcurrency?: number;
      protocolVersion?: number;
      workerVersion?: string;
    }>(c);
    const result = await reg.registerWorker({
      pairingToken: body.pairingToken ?? "",
      name: body.name ?? "",
      os: body.os,
      arch: body.arch,
      labels: body.labels,
      providers: body.providers,
      maxConcurrency: body.maxConcurrency,
      protocolVersion: body.protocolVersion,
      workerVersion: body.workerVersion,
    });
    if (!result.ok) {
      // 409 for a version mismatch (#754): it is neither a credential problem nor a
      // malformed request, and the daemon must be able to tell "never going to work,
      // stop and say so" from "retry" without reading the message.
      const status = result.error.startsWith(PROTOCOL_MISMATCH_PREFIX)
        ? 409
        : result.error.includes("pairing token")
          ? 401
          : 422;
      return c.json({ error: result.error, boardProtocolVersion: reg.boardProtocolVersion() }, status);
    }
    return c.json(result, 201);
  });

  router.post("/:id/heartbeat", async (c) => {
    const token = bearerFrom(c);
    const body = await parseOptionalJsonBody<{
      status?: WorkerStatus;
      capabilities?: unknown;
      protocolVersion?: number;
      workerVersion?: string;
    }>(c);
    const capabilities = parseWorkerCapabilities(body.capabilities);
    const result = await reg.heartbeat(c.req.param("id"), token ?? "", {
      status: body.status,
      ...(capabilities ? { capabilities } : {}),
      // Only forward the key when the worker sent one: `"protocolVersion" in opts` is how
      // the registry distinguishes "declared nothing" (a legacy caller, e.g. the board's
      // own internal touch) from "declared a version we must judge".
      ...("protocolVersion" in body ? { protocolVersion: body.protocolVersion } : {}),
      ...(body.workerVersion !== undefined ? { workerVersion: body.workerVersion } : {}),
    });
    if (!result.ok) {
      const status = result.error === "unauthorized"
        ? 401
        : result.error?.startsWith(PROTOCOL_MISMATCH_PREFIX)
          ? 409
          : 422;
      return c.json({ error: result.error, boardProtocolVersion: reg.boardProtocolVersion() }, status);
    }
    return c.json({ ok: true });
  });
}

/** The full surface, mounted on the main (loopback) app at /api/workers. */
export function createWorkersRoute(database: Database, registry?: WorkerRegistry) {
  const router = createRouter();
  const reg = registry ?? getWorkerRegistry(database);
  registerOwnerRoutes(router, reg, database);
  registerWorkerFacingRoutes(router, reg);
  return router;
}

/**
 * The worker-called subset ONLY — for the off-loopback fleet listener.
 *
 * Splitting by AUDIENCE rather than by URL prefix is the point: it makes
 * "the board API is not reachable from the network" a property of what is
 * mounted where, instead of a warning in the docs that a misconfiguration can
 * quietly violate.
 */
export function createFleetWorkersRoute(database: Database, registry?: WorkerRegistry) {
  const router = createRouter();
  registerWorkerFacingRoutes(router, registry ?? getWorkerRegistry(database));
  return router;
}
