import type { Context } from "hono";
import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { getPluginService, PluginError } from "../services/plugin.service.js";
import { createIssueService } from "../services/issue.service.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createWebhookSender } from "../services/outbound-webhook.service.js";

/**
 * Plugin-system REST surface, mounted at `/plugins` (routes/index.ts):
 *
 *   GET    /api/plugins?projectId=            list (manifest + enabled flag when projectId given)
 *   GET    /api/plugins/marketplace?projectId=  installed plugins merged with the machine's
 *            catalog file (~/.agentic-kanban/plugins/marketplace.json) of installable plugins
 *   POST   /api/plugins { source }            install (local dir or git URL)
 *   POST   /api/plugins/:id/update            git pull --ff-only (board-managed clones) +
 *            re-read the manifest; stops the plugin's running views when HEAD moved
 *   DELETE /api/plugins/:id                   remove row + disable (files kept)
 *   POST   /api/plugins/:id/enable  { projectId }
 *   POST   /api/plugins/:id/disable { projectId }
 *   GET    /api/plugins/:id/output-location?projectId=   where scaffold/script/loop output goes
 *   POST   /api/plugins/:id/output-location { projectId, location: "leading" | "sidecar" } —
 *            "leading" (default) writes into the project's leading repo; "sidecar" writes into
 *            a dedicated repo (created on first use) named "<pluginSlug>-requirements"
 *   GET    /api/plugins/:id/views?projectId=  view descriptors + running state + url
 *   POST   /api/plugins/:id/views/:viewId/start { projectId } → { url, port, pid, ready }
 *          (`ready: false` = the child is up but not answering its health probe yet — poll
 *           `GET .../views` / the status route instead of framing the URL; #252)
 *   POST   /api/plugins/:id/views/:viewId/stop  { projectId }
 *   POST   /api/plugins/:id/scripts/:name/run   { projectId } → { code, stdout, stderr, timedOut }
 *   POST   /api/plugins/:id/skills/:name/run
 *            { projectId, title?, description?, prompt?, workflowTemplateId? } →
 *            { issueId, issueNumber, workspaceId, branch } (creates a ticket + launches a
 *            workspace against the skill — the agentic counterpart to scripts/:name/run).
 *            `prompt` is extra context for this run, appended to the skill's brief.
 *            `workflowTemplateId` picks the ticket's workflow; omitted, the manifest's declared
 *            workflow for the skill wins, and failing that the board's per-issue-type default.
 *            With `?stream=1` (or Accept: text/event-stream) the same call streams SSE progress
 *            events instead — `ticket` the moment the ticket exists, `workspace` while the
 *            worktree + setup script run, then `done`/`error`. The launch takes MINUTES; without
 *            this a caller has no evidence it started until the very end.
 *   GET    /api/plugins/:id/loops?projectId=    per-loop ticket counts (planner NOT run)
 *   POST   /api/plugins/:id/loops/:name/advance { projectId } → one advance of a converging
 *            loop: plan, then a ticket per outstanding unit for the board's monitor to start
 *   POST   /api/plugins/:id/loops/:name/pause  { projectId } → stops the monitor's
 *            auto-advance for this loop only (manual "Advance now" still works)
 *   POST   /api/plugins/:id/loops/:name/resume { projectId } → re-arms auto-advance
 *
 * The client's flat per-project listings live under the `/projects` prefix
 * (convention: per-project reads hang off /projects/:projectId/...):
 *
 *   GET    /api/projects/:projectId/plugin-views     (view host — views only)
 *   GET    /api/projects/:projectId/plugin-surface   (Plugins panel — views+loops+scripts+skills)
 */
export function createPluginsRoute(
  database: Database,
  options?: { getSessionManager?: () => SessionManager; boardEvents?: BoardEvents },
) {
  const router = createRouter();
  const issueService = createIssueService({
    database,
    boardEvents: options?.boardEvents,
    sendWebhook: createWebhookSender(database),
  });
  const workspaceService = createWorkspaceService({
    database,
    getSessionManager: options?.getSessionManager,
    boardEvents: options?.boardEvents,
  });
  const service = getPluginService(database, {
    createIssue: issueService.createIssue,
    createWorkspace: workspaceService.createWorkspace,
    boardEvents: options?.boardEvents,
  });

  router.get("/", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    return c.json(await service.listPlugins(projectId));
  });

  router.get("/marketplace", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    return c.json(await service.listMarketplace(projectId));
  });

  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const source = typeof body.source === "string" ? body.source : "";
    return c.json(await service.installPlugin({ source }), 201);
  });

  // Parse + reference-check a local plugin dir WITHOUT installing (#295).
  router.post("/validate", async (c) => {
    const body = await parseJsonBody(c);
    const source = typeof body.source === "string" ? body.source : "";
    return c.json(await service.validatePluginSource(source));
  });

  router.post("/:id/update", async (c) => {
    return c.json(await service.updatePlugin(c.req.param("id")));
  });

  router.delete("/:id", async (c) => {
    await service.removePlugin(c.req.param("id"));
    return c.json({ success: true });
  });

  async function requireProjectId(c: Context): Promise<string> {
    const body = await parseOptionalJsonBody<{ projectId?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    return projectId;
  }

  // #318: `location` is OPTIONAL and applied before scaffolding. Enabling scaffolds
  // into the resolved output repo, so choosing the location afterwards left the
  // scaffold in the wrong repo. Omitting it preserves the previous behaviour exactly.
  router.post("/:id/enable", async (c) => {
    const body = await parseOptionalJsonBody<{ projectId?: string; location?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const location = typeof body.location === "string" ? body.location : undefined;
    return c.json(await service.enableForProject(c.req.param("id"), projectId, location));
  });

  router.post("/:id/disable", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.disableForProject(c.req.param("id"), projectId));
  });

  router.get("/:id/output-location", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    return c.json(await service.getOutputLocation(c.req.param("id"), projectId));
  });

  router.post("/:id/output-location", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; location?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const location = typeof body.location === "string" ? body.location : "";
    return c.json(await service.setOutputLocation(c.req.param("id"), projectId, location));
  });

  router.get("/:id/views", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    return c.json(await service.listViews(c.req.param("id"), projectId));
  });

  router.post("/:id/views/:viewId/start", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.startView(c.req.param("id"), c.req.param("viewId"), projectId));
  });

  router.post("/:id/views/:viewId/stop", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.stopView(c.req.param("id"), c.req.param("viewId"), projectId));
  });

  router.get("/:id/loops", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    return c.json(await service.listLoops(c.req.param("id"), projectId));
  });

  router.post("/:id/loops/:name/advance", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.advanceLoop(c.req.param("id"), c.req.param("name"), projectId));
  });

  // Apply a human's gate decision (#286): run the plugin's resolve command, then re-plan.
  router.post("/:id/loops/:name/gate/resolve", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; gateId?: string; actionId?: string; input?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const gateId = typeof body.gateId === "string" ? body.gateId.trim() : "";
    const actionId = typeof body.actionId === "string" ? body.actionId.trim() : "";
    if (!gateId || !actionId) throw new PluginError("gateId and actionId are required", "BAD_REQUEST");
    return c.json(await service.resolveLoopGate(c.req.param("id"), c.req.param("name"), projectId, {
      gateId,
      actionId,
      input: typeof body.input === "string" ? body.input : undefined,
    }));
  });

  // Audit timeline + per-unit cost rollup for one loop (#292, #294).
  router.get("/:id/loops/:name/events", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json(await service.listLoopEvents(c.req.param("id"), c.req.param("name"), projectId, limit));
  });

  // A declared loop artifact, read fresh from the output repo (#288).
  // `withDiff=1` opts into the extra `git diff` spawn (#421) — omit it for the
  // Rendered/Raw open, which is the overwhelming majority of reads.
  router.get("/:id/loops/:name/artifact", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    const path = c.req.query("path")?.trim();
    const withDiff = c.req.query("withDiff") === "1";
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    if (!path) throw new PluginError("path query param is required", "BAD_REQUEST");
    return c.json(await service.getLoopArtifact(c.req.param("id"), projectId, path, { withDiff }));
  });

  // Edit-then-approve (#305): overwrite one of the current gate's artifacts and commit it.
  router.put("/:id/loops/:name/artifact", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; gateId?: string; path?: string; content?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const gateId = typeof body.gateId === "string" ? body.gateId.trim() : "";
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!gateId || !path || typeof body.content !== "string") {
      throw new PluginError("gateId, path and content are required", "BAD_REQUEST");
    }
    return c.json(await service.saveLoopArtifact(c.req.param("id"), c.req.param("name"), projectId, {
      gateId, path, content: body.content,
    }));
  });

  // Draft-with-butler (#310): rough notes in, submit-ready revision feedback out.
  router.post("/:id/loops/:name/gate/draft", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; gateId?: string; notes?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const gateId = typeof body.gateId === "string" ? body.gateId.trim() : "";
    const notes = typeof body.notes === "string" ? body.notes : "";
    if (!gateId) throw new PluginError("gateId is required", "BAD_REQUEST");
    return c.json(await service.draftLoopGateFeedback(c.req.param("id"), c.req.param("name"), projectId, { gateId, notes }));
  });

  // Summarize-for-me (#330): decision-ready butler digest of the current gate's artifacts.
  router.post("/:id/loops/:name/gate/summarize", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; gateId?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const gateId = typeof body.gateId === "string" ? body.gateId.trim() : "";
    if (!gateId) throw new PluginError("gateId is required", "BAD_REQUEST");
    return c.json(await service.summarizeLoopGate(c.req.param("id"), c.req.param("name"), projectId, { gateId }));
  });

  // The scaffold's unresolved TODO markers as a form (#291).
  router.get("/:id/scaffold", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    return c.json(await service.getScaffoldForm(c.req.param("id"), projectId));
  });

  router.post("/:id/scaffold", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; values?: Array<{ index?: number; value?: string }> }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    if (!Array.isArray(body.values)) throw new PluginError("values must be an array", "BAD_REQUEST");
    const values = body.values
      .filter((v) => typeof v?.index === "number" && typeof v?.value === "string")
      .map((v) => ({ index: v.index as number, value: v.value as string }));
    return c.json(await service.fillScaffoldForm(c.req.param("id"), projectId, values));
  });

  // Overwrite the whole scaffold file (#438). `POST` addresses TODO markers by index,
  // so a COMPLETE profile — which has none — was uneditable from the board entirely.
  router.put("/:id/scaffold", async (c) => {
    const body = await parseJsonBody<{ projectId?: string; content?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    if (typeof body.content !== "string") throw new PluginError("content must be a string", "BAD_REQUEST");
    return c.json(await service.saveScaffoldContent(c.req.param("id"), projectId, body.content));
  });

  router.post("/:id/loops/:name/pause", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.setLoopPaused(c.req.param("id"), c.req.param("name"), projectId, true));
  });

  router.post("/:id/loops/:name/resume", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.setLoopPaused(c.req.param("id"), c.req.param("name"), projectId, false));
  });

  router.post("/:id/scripts/:name/run", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.runScript(c.req.param("id"), c.req.param("name"), projectId));
  });

  router.post("/:id/skills/:name/run", async (c) => {
    const body = await parseOptionalJsonBody<{
      projectId?: string; title?: string; description?: string; prompt?: string;
      workflowTemplateId?: string | null;
    }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const pluginId = c.req.param("id");
    const skillName = c.req.param("name");
    const opts = {
      title: body.title,
      description: body.description,
      prompt: body.prompt,
      // Empty string from a `<select>` means "let the plugin/board decide", not "no workflow".
      workflowTemplateId: body.workflowTemplateId || undefined,
    };

    const wantsStream = c.req.query("stream") === "1"
      || (c.req.header("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) {
      const result = await service.runSkill(pluginId, skillName, projectId, opts);
      return c.json(result, 201);
    }

    // SSE from a POST — consumed with fetch + ReadableStream, never EventSource (which is
    // GET-only); same pattern as the merge queue. The response opens immediately, so the caller
    // can show the ticket long before the workspace behind it is provisioned.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) => {
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
          catch { /* client went away mid-launch; the launch itself carries on */ }
        };
        try {
          await service.runSkill(pluginId, skillName, projectId, { ...opts, onProgress: send });
        } catch (err) {
          send({ stage: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  return router;
}

/** Mounted at `/projects` — the flat enabled-plugin listings the client panels read. */
export function createPluginProjectViewsRoute(database: Database) {
  const router = createRouter();
  const service = getPluginService(database);

  router.get("/:projectId/plugin-views", async (c) => {
    return c.json(await service.listProjectViews(c.req.param("projectId")));
  });

  router.get("/:projectId/plugin-surface", async (c) => {
    return c.json(await service.listProjectSurface(c.req.param("projectId")));
  });

  return router;
}
