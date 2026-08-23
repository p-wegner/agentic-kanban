/**
 * Request-body schemas for the `/api/codemods` routes (#806).
 *
 * These are the highest blast radius of the batch: `POST /apply` WRITES FILES on disk, using
 * `projectId` to resolve the repo path that is also its security boundary. An unvalidated body
 * there is not a typing nicety.
 *
 * Written against `./body-schema-helpers.js`, which carries the three rules (verbatim messages,
 * guard order preserved, predicates copied not tightened) that make this swap behaviour-
 * preserving. Read that file before editing these.
 *
 * One thing these guards did that the schemas do NOT reproduce, deliberately: `!body.x?.trim()`
 * THROWS a TypeError on a non-string (`(5).trim` is not a function), which the error middleware
 * renders as a 500. The schemas answer 400 with the guard's own message instead. That is a
 * status change only for bodies that already failed — no request that used to SUCCEED is
 * affected, which is the line that separates a hardening from a regression.
 */
import { z } from "zod";
import { required, arrayOnly, unchecked } from "./body-schema-helpers.js";

/**
 * `POST /api/codemods/preview`.
 *
 * `overrideLimit` and `script` had no guard at all; they get the type the route already
 * declared (the sanctioned #512 tightening), so a caller sending `overrideLimit: "yes"` is told
 * so rather than having the string's truthiness decide whether a file-count cap applies.
 */
export const codemodPreviewBody = z.object({
  description: required("description is required"),
  projectId: required("projectId is required"),
  overrideLimit: z.boolean().optional(),
  script: z.string().optional(),
}).passthrough();

/**
 * `POST /api/codemods/apply`.
 *
 * `changes` keeps ONE message for both halves of `!Array.isArray(...) || ...length === 0`,
 * because that was one guard — splitting it would change what a caller sending `[]` is told.
 * Its element shape is deliberately unvalidated (rule 3); `selectedFiles` likewise, since it
 * never had a guard and `z.array(z.string())` would start rejecting bodies accepted today.
 */
export const codemodApplyBody = z.object({
  projectId: required("projectId is required"),
  changes: arrayOnly<{ filePath: string; modified: string }>(
    "changes array is required and must not be empty",
    (v) => v.length > 0,
  ),
  selectedFiles: unchecked<string[]>(),
}).passthrough();

/** `POST /api/codemods` — save a codemod. Field order is the guard order: name, description, script. */
export const codemodCreateBody = z.object({
  name: required("name is required"),
  description: required("description is required"),
  script: required("script is required"),
  // NOT `z.string().nullable().optional()`: a zod union reports its own "Invalid input" for a
  // wrong type, which is neither this endpoint's voice nor a message any guard ever produced.
  // The field had no guard, so it keeps having none (rule 3) rather than gaining an opaque one.
  projectId: unchecked<string | null>(),
}).passthrough();
