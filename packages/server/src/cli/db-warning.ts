/**
 * Split-brain warning (#112) for a CLI subcommand that resolved to the
 * home-fallback DB (~/.agentic-kanban/kanban.db), or `null` when the DB is
 * explicitly located (DB_URL / AGENTIC_KANBAN_DIR / in-checkout dev DB).
 *
 * A dev server started from a checkout uses the in-checkout
 * packages/server/kanban.db, so a CLI that home-falls-back silently reads/mutates
 * a DIFFERENT database than the running server. Pure so it is unit-testable
 * without executing the CLI (which parses argv on import).
 */
export function homeFallbackDbWarning(loc: {
  source: string;
  path: string | null;
  url: string;
}): string | null {
  if (loc.source !== "home-fallback") return null;
  return (
    `⚠ agentic-kanban CLI is using the home-fallback database:\n` +
    `    ${loc.path ?? loc.url}\n` +
    `  A dev server run from a checkout uses packages/server/kanban.db instead, so this\n` +
    `  CLI may be reading/writing a DIFFERENT database than the running server.\n` +
    `  Set AGENTIC_KANBAN_DIR or DB_URL to point both at the same DB.`
  );
}
