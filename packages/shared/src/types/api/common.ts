// Cross-cutting wire-contract types shared across multiple resource modules.
// Pure type-only DTOs (see ../api.ts barrel + types/index.ts `export type *`).

/** Tagged profile selection — provider-aware replacement for the bare claudeProfile string. */
export interface ProfileSelection {
  provider: "claude" | "codex" | "copilot" | "pi";
  name: string;
}
