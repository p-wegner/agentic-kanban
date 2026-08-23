import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { voiceCaptureBody } from "./voice-capture-body-schemas.js";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import { createVoiceCaptureIssue, VoiceCaptureCommandError } from "../services/voice-capture.service.js";

/**
 * Voice capture route — mounted under /projects so paths resolve as:
 *   POST /api/projects/:id/voice-capture
 */
export function createVoiceCaptureRoute(
  database: Database,
  options?: { boardEvents?: BoardEventSink },
) {
  const router = createRouter();

  // POST /api/projects/:id/voice-capture
  // Body: { transcript: string, speechLanguage?: string | null, speechLanguageLabel?: string | null }
  // Creates a Backlog issue from a voice transcript using Claude to structure it.
  router.post("/:id/voice-capture", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody(c, voiceCaptureBody);

    try {
      const result = await createVoiceCaptureIssue(
        {
          projectId,
          // `voiceCaptureBody` already trims, exactly as the old `.trim()` here did.
          transcript: body.transcript,
          speechLanguage: body.speechLanguage ?? null,
          speechLanguageLabel: body.speechLanguageLabel ?? null,
        },
        database,
        options?.boardEvents,
      );
      return c.json(result, 201);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Internal error";
      if (err instanceof VoiceCaptureCommandError) {
        return c.json({ error: message }, 422);
      }
      if (message.includes("No statuses configured") || message.includes("not found")) {
        return c.json({ error: message }, 422);
      }
      console.error("[voice-capture] failed:", err);
      return c.json({ error: "Failed to create voice capture issue" }, 500);
    }
  });

  return router;
}
