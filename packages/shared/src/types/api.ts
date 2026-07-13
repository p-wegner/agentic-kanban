// API request/response types — the hand-authored WIRE CONTRACT (pure DTOs the client
// imports as `import type`). Runtime provider/model values + logic live in
// ../lib/provider-models.ts so this file stays type-only (see types/index.ts:
// `export type *`).
//
// This module is a BARREL: the ~75 DTOs were split by resource/feature into ./api/*
// (arch-review 2026-07-07 §1.4 — types/api.ts was a 964-line, 122-commits/90d
// append-target and one of the two worst parallel-agent merge-conflict magnets in the
// repo). Every existing importer of `.../types/api` keeps working unchanged because the
// full surface is re-exported here. `export type *` keeps the barrel purely type-only so
// client-bundle safety is preserved.
//
// NOTE (deferred, out of scope): the zod-inferred / ts-rest route-contract migration that
// would make DTO drift fail loud at runtime (lib/api.ts:19 still casts `res.json() as T`;
// zero `zValidator` routes) is a separate, wide-blast-radius follow-up — see review §1.4.
export type * from "./api/common.js";
export type * from "./api/project.js";
export type * from "./api/flake.js";
export type * from "./api/issue.js";
export type * from "./api/workspace.js";
export type * from "./api/session.js";
export type * from "./api/diff.js";
export type * from "./api/dependency.js";
export type * from "./api/drive.js";
export type * from "./api/board.js";
export type * from "./api/quality-metrics.js";
