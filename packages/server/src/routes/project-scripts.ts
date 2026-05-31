import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createProjectScriptsService } from "../services/project-scripts.service.js";

function encodeEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export function createProjectScriptsRoute(database: Database) {
  const router = createRouter();
  const service = createProjectScriptsService({ database });

  router.get("/:projectId/scripts", async (c) => {
    return c.json(await service.list(c.req.param("projectId")));
  });

  router.post("/:projectId/scripts", async (c) => {
    const body = await parseJsonBody(c);
    return c.json(await service.create(c.req.param("projectId"), body), 201);
  });

  router.patch("/:projectId/scripts/:scriptId", async (c) => {
    const body = await parseJsonBody(c);
    return c.json(await service.update(c.req.param("projectId"), c.req.param("scriptId"), body));
  });

  router.delete("/:projectId/scripts/:scriptId", async (c) => {
    await service.remove(c.req.param("projectId"), c.req.param("scriptId"));
    return c.json({ success: true });
  });

  router.post("/:projectId/scripts/:scriptId/run", async (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        service.run(c.req.param("projectId"), c.req.param("scriptId"), (event) => {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        }).then(() => controller.close()).catch((err) => {
          controller.enqueue(encoder.encode(encodeEvent({
            type: "exit",
            status: "error",
            exitCode: null,
            endedAt: new Date().toISOString(),
            error: err instanceof Error ? err.message : String(err),
          })));
          controller.close();
        });
      },
    });
    return c.body(stream, 200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  });

  return router;
}
