/**
 * Request-body schemas for `routes/drive-obstacles.ts` (#806, batch 3).
 *
 * See `./body-schema-helpers.js` for the three rules that make a guard→schema swap
 * behaviour-preserving: messages copied verbatim, fields declared in the order the guards
 * ran, predicates copied rather than tightened.
 */
import { z } from "zod";
import { requiredTrimmed, unchecked } from "./body-schema-helpers.js";
import {
  isDriveObstacleKind,
  isDriveObstacleSeverity,
  DRIVE_OBSTACLE_KINDS,
  DRIVE_OBSTACLE_SEVERITIES,
} from "../services/drive-obstacles.service.js";
import type { DriveObstacleKind, DriveObstacleSeverity } from "../services/drive-obstacles.service.js";

/**
 * `POST /api/projects/:projectId/drive-obstacles`.
 *
 * The two enum messages are built from the same constants the guards used, so the text is
 * identical rather than merely similar. `severity` is `.optional()`, which short-circuits
 * before the predicate — that is the `body.severity !== undefined &&` half of its guard.
 * `summary` is `requiredTrimmed` because the handler records `body.summary.trim()`.
 */
export const driveObstacleBody = z.object({
  driveId: unchecked<string | null>(),
  kind: z.custom<DriveObstacleKind>((v) => isDriveObstacleKind(v), {
    message: `kind must be one of: ${DRIVE_OBSTACLE_KINDS.join(", ")}`,
  }),
  severity: z
    .custom<DriveObstacleSeverity>((v) => isDriveObstacleSeverity(v), {
      message: `severity must be one of: ${DRIVE_OBSTACLE_SEVERITIES.join(", ")}`,
    })
    .optional(),
  issueNumber: unchecked<number | null>(),
  summary: requiredTrimmed("summary is required"),
  details: unchecked<unknown>(),
}).passthrough();
