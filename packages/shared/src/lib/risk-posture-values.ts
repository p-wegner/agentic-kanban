/**
 * The four risk-posture levels (#911, decision 017). Declared here — pure, client-safe,
 * no drizzle/schema/node imports — rather than beside the resolver in `packages/server`,
 * so the settings route/MCP `set_preference` write path and the client (#912) validate
 * against exactly the same list `resolveRiskPosture` accepts.
 */
export const RISK_POSTURE_VALUES = ["strict", "standard", "fast", "sprint"] as const;
