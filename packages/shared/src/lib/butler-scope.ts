/**
 * The reserved, synthetic projectId for the GLOBAL (project-less) butler.
 *
 * The butler is normally scoped to a project (its cwd is the project's repo). When NO
 * project is registered/active, the client can still open a butler by using this id as
 * the projectId in every `/api/projects/:id/butler...` call. The server special-cases it
 * (see `resolveProject` in routes/butler.ts): instead of a DB lookup it returns a
 * synthetic project rooted at the projects base directory, so the global butler can help
 * the user register or create their first project. A real project id is always a UUID, so
 * this sentinel can never collide with one.
 */
export const GLOBAL_BUTLER_PROJECT_ID = "__global__";

/** Display name used for the global butler's synthetic project. */
export const GLOBAL_BUTLER_PROJECT_NAME = "(no project)";
