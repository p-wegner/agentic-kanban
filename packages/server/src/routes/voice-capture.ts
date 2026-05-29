import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createVoiceCaptureIssue } from "../services/voice-capture.service.js";

/**
 * Voice capture route — mounted under /projects so paths resolve as:
 *   POST /api/projects/:id/voice-capture
 */
export function createVoiceCaptureRoute(
  database: Database,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();

  // POST /api/projects/:id/voice-capture
  // Body: { transcript: string }
  // Creates a Backlog issue from a voice transcript using Claude to structure it.
  router.post("/:id/voice-capture", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<{ transcript: string }>(c);

    if (!body.transcript?.trim()) {
      return c.json({ error: "transcript is required" }, 400);
    }

    const result = await createVoiceCaptureIssue(
      { projectId, transcript: body.transcript.trim() },
      database,
      options?.boardEvents,
    );

    return c.json(result, 201);
  });

  return router;
}
