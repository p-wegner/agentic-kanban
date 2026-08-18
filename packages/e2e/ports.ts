/**
 * The E2E stack's ports — ONE definition, imported by the Playwright config and by the
 * tests' `helpers/port.ts` (#645).
 *
 * They were two independent copies both defaulting to 3001/5173, which is a large part of
 * why the suite silently ran against the live dev board: isolating the config alone would
 * have moved the servers while every test kept calling `http://127.0.0.1:3001`, i.e. the
 * developer's board. A default that appears in two places is a default that will be
 * changed in one.
 *
 * Deliberately NOT 3001/5173: those belong to `pnpm dev`. Deliberately not derived from a
 * branch either — E2E is one stack, not per-worktree.
 */
export const E2E_SERVER_PORT = Number(process.env.SERVER_PORT) || 3901;
export const E2E_CLIENT_PORT = Number(process.env.VITE_PORT) || 5973;
