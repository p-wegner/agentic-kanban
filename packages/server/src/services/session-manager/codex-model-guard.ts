import type { ProviderName } from "../agent-provider.js";
import { WorkspaceError } from "../workspace-internals.js";
import { CODEX_SPARK_MODEL, CODEX_SAFE_DEFAULT_MODEL } from "./session-launch-helpers.js";

/** Codex launch guard: refuse the hostile spark model for builders, default an unset builder model to the safe one. */
export function guardCodexModel(providerName: ProviderName, resolvedModel: string | undefined, builderSession: boolean): string | undefined {
  if (providerName !== "codex") return resolvedModel;
  if ((resolvedModel ?? "").trim() === CODEX_SPARK_MODEL) {
    const message =
      `Refusing to launch Codex builder session with hostile model ${CODEX_SPARK_MODEL}; ` +
      `choose a safe Codex model such as ${CODEX_SAFE_DEFAULT_MODEL}.`;
    if (builderSession) {
      throw new WorkspaceError(message, "CONFLICT", {
        code: "UNSAFE_CODEX_MODEL",
        model: CODEX_SPARK_MODEL,
      });
    }
    console.warn(`[session] WARNING: ${message}`);
  } else if (!resolvedModel && builderSession) {
    console.warn(
      `[session] Codex builder launch has no explicit model; using ${CODEX_SAFE_DEFAULT_MODEL} ` +
      "instead of relying on CODEX_HOME config.toml.",
    );
    return CODEX_SAFE_DEFAULT_MODEL;
  }
  return resolvedModel;
}
