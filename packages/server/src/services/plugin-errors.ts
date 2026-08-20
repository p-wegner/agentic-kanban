/**
 * The plugin domain error, in its own module so that helper modules (`plugin-fs.ts`) can throw
 * it without importing `plugin.service.ts` and creating an import cycle.
 *
 * `plugin.service.ts` re-exports it, so every existing `import { PluginError } from
 * "./plugin.service.js"` keeps working.
 */
export class PluginError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "PluginError";
  }
}
