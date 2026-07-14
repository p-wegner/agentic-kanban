// api.ts is the pure wire contract — type-only. Runtime provider/model values moved to
// lib/provider-models.ts (re-exported through the lib barrel, so `@agentic-kanban/shared`
// still surfaces them as values).
export type * from "./api.js";
// service-stack.ts is a pure module (interfaces + a plain const default, no Node
// builtins) so it is client-bundle safe to re-export as a VALUE — the value export
// is needed for DEFAULT_SERVICE_STACK_CONFIG.
export * from "./service-stack.js";
