import { ConflictError, UnprocessableError } from "../errors/index.js";
import type { Context, Hono } from "hono";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { workerSettingsBody } from "./worker-body-schemas.js";
import { extractBearer } from "../lib/bearer-token.js";
import type { Database } from "../db/index.js";
import {
  getWorkerRegistry,
  PROTOCOL_MISMATCH_PREFIX,
  type WorkerRegistry,
  type WorkerStatus,
} from "../services/worker-registry.service.js";
import { parseWorkerProfileAttestations, parseWorkerCapabilities, parseWorkerDoctorSummary } from "@agentic-kanban/shared/lib/worker-protocol";
import {
  listIncomingRefs,
  landIncomingRef,
  discardIncomingRef,
} from "../services/worker-incoming-refs.service.js";
import {
  describeFleet,
  explainIssuePlacement,
  explainPlacement,
  listSessionPlacements,
} from "../services/placement-explain.service.js";
import {
  WORKER_EVENT_TYPES,
  forgetWorkerEvents,
  listWorkerEvents,
  recordWorkerEvent,
} from "../services/worker-events.service.js";
import { readTier0Capacity } from "@agentic-kanban/shared/lib/machine-capacity";
import {
  resolveVerifyChainSlots,
  verifyChainSemaphoreActive,
  verifyChainSemaphoreQueueLength,
} from "../services/verify-chain-semaphore.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import {
  changedSettingKeys, parseWorkerSettings, parseWorkerSettingsReport, type WorkerSettings,
} from "@agentic-kanban/shared/lib/worker-settings";
import { classifyWorkerDrop } from "../services/worker-drop-diagnosis.js";
import { getProjectById } from "../repositories/project.repository.js";
import { suggestToolchainsForRepo } from "../services/toolchain-suggestions.js";
import { formatToolchainRequirement } from "@agentic-kanban/shared/lib/worker-toolchains";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";
import { listWorkerBranchAssignments } from "../repositories/worker.repository.js";
import type { ProviderName } from "../services/agent-provider.js";
import { resolveBoardCommit, resolveOwnPackageVersion } from "../lib/worker-build.js";
import { resolveBoardGitFacts } from "../lib/board-git-facts.js";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { parseWorkerUpdateReport } from "../lib/worker-update.js";
import { getWorkerBuildService, type WorkerBuildService } from "../services/worker-build.service.js";
import type { BoardEventSink } from "../services/board-events.js";
import { buildWorkerConnectSteps } from "../lib/worker-connect-steps.js";
import { BOOTSTRAP_TOKEN_PLACEHOLDER, buildWorkerBootstrap } from "@agentic-kanban/shared/lib/worker-bootstrap-steps";
import { createConnectOwnerRoute } from "./worker-connect.js";
import { getConnectCodeStore } from "../services/worker-connect-code.service.js";
import { parseHostList } from "../lib/listen-hosts.js";
import { resolveFleetPort, resolveFleetHost, boardIdentityField } from "../services/fleet-listener.service.js";
import { isTailscaleHost } from "../lib/tailscale-host.js";
import { resolveConfiguredGitPort, resolveConfiguredGitHost } from "../services/git-http.service.js";

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
 * Which worker produced an incoming ref, resolved from the persisted DISPATCH record
 * (`sessions.workerId` + the workspace branch) rather than from the ref itself.
 *
 * The ref alone proves nothing about who pushed it — that is the whole point of #246, and
 * `listIncomingRefs` reports `hasWorkerAssignment` off the same record. Neither
 * `landIncomingRef` nor `discardIncomingRef` returns a worker id, so an event about a ref
 * has to look the owner up; a ref whose owner cannot be resolved produces NO event rather
 * than one attributed to a guess (an unattributable ref is exactly the #246 case, and
 * pinning it on a worker would be the wrong answer, not a rough one).
 *
 * Newest dispatch wins when a branch was dispatched more than once: the ref sitting in the
 * staging namespace now was pushed by the most recent worker to hold it.
 */
async function resolveRefOwner(
  database: Database,
  projectId: string,
  branch: string,
): Promise<{ workerId: string; sessionId: string } | null> {
  const assignments = await listWorkerBranchAssignments(projectId, database);
  const match = assignments.find((a) => a.branch === branch);
  return match ? { workerId: match.workerId, sessionId: match.sessionId } : null;
}

/**
 * The fleet URL a worker's `--board` must point at: `http://<KANBAN_FLEET_HOST or 127.0.0.1>:<port>`,
 * or `fleetUrl: null` plus a reason when no fleet listener is configured. A wildcard bind
 * (0.0.0.0 / ::) is not a dialable address, so it is rendered as a `<board-host>` placeholder.
 */
export function describeFleetUrl(env: NodeJS.ProcessEnv = process.env): { fleetUrl: string | null; fleetNote: string | null } {
  const port = resolveFleetPort(env);
  if (port === null) {
    return { fleetUrl: null, fleetNote: "fleet listener disabled: set KANBAN_FLEET_PORT" };
  }
  // #1337: with a host LIST the first entry is the preferred URL shown to the operator.
  const host = parseHostList(resolveFleetHost(env))[0] ?? "127.0.0.1";
  const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
  const tailscale = isTailscaleHost(host);
  const shown = wildcard ? "<board-host>" : tailscale ? "<tailscale-ip>" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return {
    fleetUrl: `http://${shown}:${port}`,
    fleetNote: wildcard
      ? "fleet listener binds every interface; substitute this machine's reachable address for <board-host>"
      : tailscale
        ? "fleet listener binds the address `tailscale ip -4` reports; substitute it for <tailscale-ip>"
        : null,
  };
}

/**
 * Owner-only endpoints. These stay on the LOOPBACK app forever: minting a
 * pairing token, listing the fleet and revoking a worker are administrative
 * actions with no credential of their own — they ride the board's
 * "only reachable from this machine" trust, exactly like the rest of /api.
 */
function registerOwnerRoutes(router: Hono, reg: WorkerRegistry, database: Database, boardEvents?: BoardEventSink): void {
  // #1442: one-time connect codes for the agent-readable /connect/<code> page (served on the fleet listener).
  router.route("/connect-code", createConnectOwnerRoute(reg, () => describeFleetUrl()));

  router.post("/pairing-token", (c) =>
    // #1318: also names the fleet URL, which is what `worker start --board` needs.
    c.json({ ...reg.mintPairingToken(), ...describeFleetUrl() }, 201));

  // #774 - the list route used to answer the raw `workers` rows, so `connected`, `load`
  // and free-slot count were all unavailable, and `WorkerFleetPanel` derived "capacity" as
  // the sum of `maxConcurrency` over heartbeat-online workers: total capacity presented as
  // free capacity. It now serves `describeFleet`, the SAME computation the placement
  // explanation uses, so the panel and the explain endpoint cannot disagree.
  //
  // `workers` stays the top-level key and every previous field is still on each row, so the
  // existing CLI (`worker list`) and panel keep working against the enriched shape.
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    const provider = (c.req.query("provider") as ProviderName | undefined) ?? undefined;
    // `reg` and not the singleton: this route takes an injectable registry, and #774 moved the
    // listing onto `describeFleet`, which reached past the injection (#799).
    const fleet = await describeFleet({ database, projectId, providerName: provider, registry: reg });
    return c.json({
      workers: fleet.workers.map((w) => ({
        // `id` as well as `workerId`: the panel needs an id to revoke by, and every existing
        // consumer has read `id` since epic #1. Renaming it would have been a silent break.
        id: w.workerId,
        ...w,
      })),
      fleet: {
        registered: fleet.registered,
        online: fleet.online,
        connected: fleet.connected,
        eligible: fleet.eligible,
        freeSlots: fleet.freeSlots,
        provider: fleet.provider,
        requiredLabels: fleet.requiredLabels,
        // #879: what each row's buildFreshness compares against, so the panel and
        // `worker list` can say "behind board (board runs X)".
        boardWorkerVersion: fleet.boardWorkerVersion,
      },
    });
  });

  // #1421 — what `status --watch` shows as the HOST row: free RAM against the gate floor and
  // the verify-chain slots. Cheap (one `os.freemem()` read, module-state reads), so a 2-5 s
  // refresh costs nothing.
  router.get("/host", (c) => {
    const cap = readTier0Capacity();
    const slots = resolveVerifyChainSlots();
    const facts = resolveBoardGitFacts();
    return c.json({
      boardCommit: resolveBoardCommit(),
      boardTag: facts.tag,
      mergedToday: facts.mergedToday,
      freeGb: cap.freeGb,
      hold: cap.hold,
      reason: cap.reason,
      floorGb: Number(process.env.SMART_HOOKS_MIN_FREE_GB ?? 2) || 2,
      verify: { active: verifyChainSemaphoreActive(), slots: slots.slots, queued: verifyChainSemaphoreQueueLength() },
    });
  });

  // #1382: what the project's repo files suggest for `required_toolchains` (lockfile, gradlew,
  // go.mod, pyproject...), for one-click accept in settings. Suggestions only - nothing is saved.
  router.get("/toolchain-suggestions", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) throw new UnprocessableError("projectId is required");
    const project = await getProjectById(projectId, database);
    const repoPath = project?.repoPath;
    if (!repoPath) return c.json({ suggestions: [] });
    const suggestions = await suggestToolchainsForRepo(repoPath);
    return c.json({ suggestions: suggestions.map(formatToolchainRequirement) });
  });

  // #774 - the per-worker timeline. Before this the board stored nothing about what a worker
  // did, so a #699/#706-class failure ("it vanished mid-run and the session hung") was
  // reconstructed from server scrollback that a restart had already discarded.
  //
  // Owner-only, like the rest of this block: an event summary names sessions and branches.
  router.get("/:id/events", async (c) => {
    const limitParam = Number(c.req.query("limit"));
    const typesParam = c.req.query("types");
    const types = typesParam
      ? typesParam
          .split(",")
          .map((t) => t.trim())
          .filter((t) => (WORKER_EVENT_TYPES as readonly string[]).includes(t))
      : undefined;
    if (typesParam && (!types || types.length === 0)) {
      throw new UnprocessableError(
        `types must be a comma-separated subset of: ${WORKER_EVENT_TYPES.join(", ")}`,
      );
    }
    const workerId = c.req.param("id");
    return c.json({
      workerId,
      events: await listWorkerEvents({
        database,
        workerId,
        limit: Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : undefined,
        types,
      }),
      // #881 — why the worker went away, derived from the timeline rather than probed.
      // Deliberately computed from its OWN query over the transport rows, NOT from the
      // `events` above: those honour the caller's `types`/`limit`, and a diagnosis derived
      // from a filtered window would be confidently wrong (ask for `assigned` only and the
      // classifier would see no drops at all and report health).
      diagnosis: classifyWorkerDrop(
        await listWorkerEvents({
          database,
          workerId,
          types: ["connected", "disconnected", "status_change"],
          limit: 200,
        }),
      ),
    });
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
    // #774 - an incoming ref moving a real branch is exactly the kind of event that used to
    // exist only as a console line. Attributed only when the outcome names the owning worker.
    const landedBy = await resolveRefOwner(database, body.projectId, body.branch);
    if (landedBy) {
      void recordWorkerEvent({
        database,
        workerId: landedBy.workerId,
        sessionId: landedBy.sessionId,
        type: "ref_landed",
        summary: `incoming ref for ${body.branch} was landed onto the real branch`,
        payload: { projectId: body.projectId, branch: body.branch, outcome: result.outcome },
      });
    }
    // #1089 — the Runners view's Git Transport tab refetches on this instead of only its
    // own 15s poll.
    boardEvents?.broadcastToAllProjects("workers_changed");
    return c.json({ ok: true, outcome: result.outcome });
  });

  router.post("/incoming/discard", async (c) => {
    const body = await parseOptionalJsonBody<{ projectId?: string; branch?: string; force?: boolean }>(c);
    if (!body.projectId || !body.branch) throw new UnprocessableError("projectId and branch are required");
    const result = await discardIncomingRef(body.projectId, body.branch, database, { force: body.force === true });
    // `error` is optional on the result type, so the inline body this replaced could answer a
    // bare `{}` on refusal. A refusal always says why now.
    if (!result.ok) throw new ConflictError(result.error ?? `discard refused for ${body.branch}`);
    const discardedFrom = await resolveRefOwner(database, body.projectId, body.branch);
    if (discardedFrom) {
      void recordWorkerEvent({
        database,
        workerId: discardedFrom.workerId,
        sessionId: discardedFrom.sessionId,
        type: "ref_discarded",
        summary: `incoming ref for ${body.branch} was discarded${body.force === true ? " (forced)" : ""}`,
        payload: {
          projectId: body.projectId,
          branch: body.branch,
          sha: result.sha ?? null,
          forced: body.force === true,
        },
      });
    }
    boardEvents?.broadcastToAllProjects("workers_changed");
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

  // #1338: ask ONE worker to update to the board's build now (drain + update). Owner-only:
  // it is delivered on the worker's next heartbeat (<= 30 s) as `updateNow`, so the board never
  // needs an inbound connection to the worker.
  router.post("/:id/update", async (c) => {
    const workerId = c.req.param("id");
    if (!(await reg.requestUpdate(workerId))) return c.json({ error: "worker not found" }, 404);
    boardEvents?.broadcastToAllProjects("workers_changed");
    return c.json({ ok: true, workerId, note: "delivered on the worker's next heartbeat (within ~30s)" });
  });

  // #1381: the operator's per-worker settings. PUT REPLACES the whole set (a key left out is
  // cleared); the worker picks it up on its next heartbeat and reports back which keys its
  // start flags pin. Audited in the worker's event timeline.
  router.get("/:id/settings", async (c) => {
    const workerId = c.req.param("id");
    const view = (await reg.listWorkersView()).find((w) => w.id === workerId);
    if (!view) return c.json({ error: "worker not found" }, 404);
    return c.json({
      workerId,
      desired: view.desiredSettings ?? null,
      pinned: view.settingsReport?.pinned ?? [],
      appliedRev: view.settingsReport?.appliedRev ?? null,
    });
  });

  router.put("/:id/settings", async (c) => {
    const workerId = c.req.param("id");
    const raw = (await parseJsonBody(c, workerSettingsBody)).settings ?? {};
    const settings: WorkerSettings = parseWorkerSettings(raw);
    if (raw.maxConcurrency !== undefined && settings.maxConcurrency === undefined) {
      throw new UnprocessableError("maxConcurrency must be an integer between 1 and 64");
    }
    const result = await reg.setDesiredSettings(workerId, settings);
    if (!result) return c.json({ error: "worker not found" }, 404);
    const changed = changedSettingKeys(result.before, settings);
    if (changed.length > 0) {
      void recordWorkerEvent({
        database,
        workerId,
        type: "settings_changed",
        summary: `settings changed on the board: ${changed.join(", ")}`,
        payload: { changed, before: result.before, after: settings },
      });
    }
    boardEvents?.broadcastToAllProjects("workers_changed");
    return c.json({ ok: true, workerId, desired: result.envelope, changed });
  });

  router.delete("/:id", async (c) => {
    const workerId = c.req.param("id");
    const ok = await reg.revokeWorker(workerId);
    if (!ok) return c.json({ error: "worker not found" }, 404);
    // #774 - the explicit deletion that makes `worker_events.worker_id` honestly FK-less,
    // exactly like `deleteGitTokensForWorker` inside `revokeWorker`. Awaited, not
    // fire-and-forget: a revoke must not answer 200 while the timeline is still being
    // dropped, or a poll arriving in between still shows a revoked worker's history.
    const forgotten = await forgetWorkerEvents(workerId, database);
    boardEvents?.broadcastToAllProjects("workers_changed");
    return c.json({ ok: true, eventsDeleted: forgotten });
  });

  // #1089 — the Connect tab's data source: fleet-listener/git-transport config plus the
  // SAME connect runbook the CLI's `worker instructions` prints, so the two never drift.
  // Owner-only: it names the board's own configured hosts/ports.
  router.get("/connect-info", (c) => {
    const fleetPort = resolveFleetPort();
    const fleetHost = resolveFleetHost();
    const gitHttpPort = resolveConfiguredGitPort();
    const gitHttpHost = resolveConfiguredGitHost();
    // The board's own externally-reachable base URL is not knowable from here (it depends on
    // the network the operator put the board on) — the fleet port is what a worker's --board
    // must point at, so build a best-effort loopback URL and let the reader substitute their
    // own host/IP the same way the CLI's `worker instructions --board` flag already does.
    const boardUrl = fleetPort ? `http://<board-host>:${fleetPort}` : "http://<board-host>:<KANBAN_FLEET_PORT>";
    // A placeholder token: this endpoint reports CONFIG, it does not mint. The Connect tab
    // fills the real value in client-side after `POST /pairing-token`, exactly like the CLI's
    // `worker instructions --token` flag does when a token isn't passed.
    const steps = buildWorkerConnectSteps(boardUrl, BOOTSTRAP_TOKEN_PLACEHOLDER);
    // #1370: the node-only bootstrap, one block per worker OS, built by the same function `worker
    // pair` prints. The Connect tab substitutes the minted token and the fleet URL it got from
    // `POST /pairing-token` (the placeholder URL here is only a best guess), so its output equals the CLI's.
    const bootstrap = {
      windows: buildWorkerBootstrap(boardUrl, BOOTSTRAP_TOKEN_PLACEHOLDER, "windows"),
      unix: buildWorkerBootstrap(boardUrl, BOOTSTRAP_TOKEN_PLACEHOLDER, "unix"),
    };
    return c.json({
      fleetConfigured: fleetPort !== null,
      fleetPort,
      fleetHost,
      gitHttpPort,
      gitHttpHost,
      boardWorkerVersion: resolveOwnPackageVersion() ?? null,
      boardUrl,
      steps,
      bootstrap,
    });
  });
}

/**
 * Worker-called endpoints. Every one authenticates for itself — a pairing token
 * at registration, the per-worker bearer token afterwards — so this is the ONLY
 * HTTP surface safe to expose off-loopback, and the fleet listener serves
 * exactly this and nothing else.
 */
function registerWorkerFacingRoutes(
  router: Hono,
  reg: WorkerRegistry,
  database: Database,
  boardEvents?: BoardEventSink,
  buildService?: WorkerBuildService,
): void {
  /** Injected in tests; otherwise the board's process-wide service (lazy: it resolves paths). */
  const buildServiceFor = async (): Promise<WorkerBuildService> => buildService ?? getWorkerBuildService();
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
      profiles?: unknown;
      doctor?: unknown;
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
      // #1027: parsed, never trusted — an attestation becomes a dispatch PERMISSION, so a
      // half-understood entry must not survive the boundary.
      profiles: parseWorkerProfileAttestations(body.profiles),
      doctor: parseWorkerDoctorSummary(body.doctor),
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
    // #774 - first row of the new worker's timeline. Fire-and-forget by design: a failed
    // diagnostic must never turn a successful registration into an error.
    void recordWorkerEvent({
      database,
      workerId: result.workerId,
      type: "registered",
      summary: `worker ${body.name ?? "(unnamed)"} registered from ${body.os ?? "unknown OS"}/${body.arch ?? "?"}`,
      payload: {
        labels: body.labels ?? [],
        providers: body.providers ?? [],
        maxConcurrency: body.maxConcurrency ?? null,
        protocolVersion: body.protocolVersion ?? null,
        workerVersion: body.workerVersion ?? null,
      },
    });
    // #1442: the first successful pairing closes any connect code bound to this token.
    getConnectCodeStore().markPaired(body.pairingToken ?? "");
    boardEvents?.broadcastToAllProjects("workers_changed");
    // #1337: the board's stable id, so the worker keys its pairing by board, not by the URL it dialed.
    return c.json({ ...result, ...(await boardIdentityField(database)) }, 201);
  });

  // #880 — the READ-ONLY update-check surface: what build is the board itself running?
  // Rides the worker-facing router so it is reachable from the FLEET port (a remote worker
  // never sees the board API), and it authenticates with the per-worker bearer token
  // rather than answering anonymously: version negotiation is a capability answer, and an
  // unauthenticated caller must not be able to fingerprint the board's build (#754 — the
  // same reason register checks the pairing token before judging the protocol).
  // Report-only by design: the board never pushes an update, and the caller never applies
  // one — `worker update-check` prints the diff and the manual steps, nothing more.
  //
  // Answers the board's own worker build + protocol version, for `worker update-check` (#880).
  router.get("/:id/update-check", async (c) => {
    const token = bearerFrom(c);
    if (!(await reg.authenticateWorker(c.req.param("id"), token ?? ""))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({
      boardProtocolVersion: reg.boardProtocolVersion(),
      boardWorkerVersion: resolveOwnPackageVersion() ?? null,
      boardCommit: resolveBoardCommit(),
    });
  });

  router.post("/:id/heartbeat", async (c) => {
    const token = bearerFrom(c);
    const body = await parseOptionalJsonBody<{
      status?: WorkerStatus;
      capabilities?: unknown;
      protocolVersion?: number;
      workerVersion?: string;
      update?: unknown;
      settings?: unknown;
    }>(c);
    const capabilities = parseWorkerCapabilities(body.capabilities);
    const update = parseWorkerUpdateReport(body.update);
    const settingsReport = parseWorkerSettingsReport(body.settings);
    const result = await reg.heartbeat(c.req.param("id"), token ?? "", {
      status: body.status,
      ...(update ? { update } : {}),
      ...(settingsReport ? { settingsReport } : {}),
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
      // #774 - a version-skew heartbeat is the one heartbeat worth a row: it repeats until
      // someone upgrades that worker, and it is invisible in the panel otherwise. Routine
      // heartbeats are deliberately NOT recorded - one row every 30 s per worker is noise
      // the per-worker retention cap would then spend its whole budget on.
      if (status === 409) {
        void recordWorkerEvent({
          database,
          workerId: c.req.param("id"),
          type: "protocol_mismatch",
          summary: result.error ?? "protocol version mismatch on heartbeat",
          payload: {
            workerProtocolVersion: body.protocolVersion ?? null,
            boardProtocolVersion: reg.boardProtocolVersion(),
            workerVersion: body.workerVersion ?? null,
          },
        });
      }
      return c.json({ error: result.error, boardProtocolVersion: reg.boardProtocolVersion() }, status);
    }
    // #1338: the board advertises its build on every heartbeat, and `updateNow` carries a
    // board-side `worker update`. An older worker ignores both (it reads only `ok`).
    let boardBuildId: string | null = null;
    try {
      boardBuildId = await (await buildServiceFor()).currentBuildId();
    } catch {
      /* no source tree / git unavailable: advertise nothing, the heartbeat still succeeds */
    }
    // #1376: does the board hold a WebSocket for this worker? `false` tells a worker whose socket
    // is half-open (board restarted, RST never arrived) to drop it and reconnect now.
    let socket = true;
    try {
      socket = getWorkerFleet(database).connections.isConnected(c.req.param("id"));
    } catch {
      /* fleet unavailable: say nothing rather than provoke a reconnect */
    }
    return c.json({ ok: true, boardBuildId, updateNow: result.updateNow === true, socket, ...(result.config ? { config: result.config } : {}) });
  });

  // #1338 (subsumes #1327): the board serves its own worker build to a paired worker. Both
  // routes need a valid WORKER bearer token — a build is code a machine will run, and the
  // manifest fingerprints the board (same reasoning as update-check above). They carry no
  // worker id in the path, so the check is "this token belongs to some registered worker".
  const requireWorker = async (c: Context): Promise<Response | null> => {
    if (await reg.authenticateAnyWorker(bearerFrom(c) ?? "")) return null;
    return c.json({ error: "unauthorized" }, 401);
  };

  // #1358: a fresh machine has no worker token yet, so these two ALSO accept an unexpired
  // pairing token (checked, never consumed, so the same token still pairs afterwards). The
  // header is `Authorization: Bearer <token>`, `x-pairing-token`, or `?token=` (curl-friendly).
  const requireWorkerOrPairing = async (c: Context): Promise<Response | null> => {
    const candidates = [bearerFrom(c), c.req.header("x-pairing-token"), c.req.query("token")];
    for (const t of candidates) {
      if (t && reg.isPairingTokenValid(t)) return null;
    }
    return requireWorker(c);
  };

  // #1366: `?wait=<seconds>` makes the lookup block while the tarball is packing, so a pasted
  // `curl -f` step cannot "succeed" on a 202 body. On timeout the lookup stays "building" and each
  // route answers a >= 400 (504). Without the flag the plain 202/409 answers are unchanged (the
  // daemon's updater, #1352, polls on those). Fractional seconds are accepted; capped at 5 min.
  const lookupBuild = async (c: Context) => {
    const svc = await buildServiceFor();
    let lookup = await svc.getBuild();
    const waitSec = Number(c.req.query("wait"));
    if (!(waitSec > 0)) return { lookup, waited: false };
    const deadline = Date.now() + Math.min(waitSec, 300) * 1000;
    while (lookup.state === "building" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(10, deadline - Date.now()))));
      lookup = await svc.getBuild();
    }
    return { lookup, waited: true };
  };

  router.get("/build", async (c) => {
    const denied = await requireWorkerOrPairing(c);
    if (denied) return denied;
    const { lookup, waited } = await lookupBuild(c);
    if (lookup.state === "ready") return c.json(lookup.manifest);
    if (lookup.state === "building") {
      if (waited) return c.json({ error: "the build did not finish within the wait window; retry" }, 504);
      // 202: not an error — the board is packing this commit's tarball; the worker polls.
      return c.json({ state: "building" }, 202);
    }
    return c.json({ error: lookup.reason }, 503);
  });

  router.get("/build/tarball", async (c) => {
    const denied = await requireWorkerOrPairing(c);
    if (denied) return denied;
    const { lookup, waited } = await lookupBuild(c);
    if (lookup.state === "building" && waited) {
      return c.json({ error: "the build did not finish within the wait window; retry" }, 504);
    }
    if (lookup.state !== "ready") {
      return c.json({ error: lookup.state === "building" ? "the build is not ready yet" : lookup.reason }, lookup.state === "building" ? 409 : 503);
    }
    return new Response(Readable.toWeb(createReadStream(lookup.tarballPath)) as unknown as ReadableStream, {
      headers: {
        "content-type": "application/gzip",
        "content-length": String(lookup.manifest.size),
        "x-build-sha256": lookup.manifest.sha256,
        "x-build-id": lookup.manifest.buildId,
      },
    });
  });
}

/** The full surface, mounted on the main (loopback) app at /api/workers. */
export function createWorkersRoute(
  database: Database,
  registry?: WorkerRegistry,
  boardEvents?: BoardEventSink,
  buildService?: WorkerBuildService,
) {
  const router = createRouter();
  const reg = registry ?? getWorkerRegistry(database);
  registerOwnerRoutes(router, reg, database, boardEvents);
  registerWorkerFacingRoutes(router, reg, database, boardEvents, buildService);
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
export function createFleetWorkersRoute(database: Database, registry?: WorkerRegistry, buildService?: WorkerBuildService) {
  const router = createRouter();
  registerWorkerFacingRoutes(router, registry ?? getWorkerRegistry(database), database, undefined, buildService);
  return router;
}
