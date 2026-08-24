/**
 * The env a verify/install subprocess must NOT inherit from the board process.
 *
 * `runSetupScript` spawns with `{ ...process.env, ...options.env }`, so every variable the
 * OPERATOR set to configure THIS board's listeners reaches the test run too. For the fleet
 * pins that is not a harmless leak, it is a guaranteed collision: a board started with
 * `KANBAN_GIT_HTTP_PORT=3002 KANBAN_GIT_HTTP_HOST=<tailnet ip>` is holding that exact socket
 * while the gate runs, and any suite that starts a git transport without an explicit port
 * resolves the same pin and dies with `EADDRINUSE`. Observed on the #846 gate: six failures
 * across `git-token-persistence` and `remote-session-socket-gap`, none of them caused by the
 * branch — its whole diff was `package.json` plus one test file.
 *
 * The failure is also MISLEADING rather than merely noisy. `remote-session-socket-gap`
 * asserts a dispatch failure says "not connected"; with the pin inherited it says
 * `listen EADDRINUSE ... 100.105.24.76:3002`, i.e. the gate reports a wrong-looking product
 * behaviour for an environmental reason. So a board that has a fleet configured — the setup
 * this feature exists for — cannot pass its own gate, and the more remote work the board
 * does, the more reliably it blocks itself.
 *
 * Blanked, not deleted, because the spread cannot express a deletion. Every consumer treats
 * empty as absent: `envPort` returns its fallback (fleet → null = disabled, git → 0 =
 * OS-assigned) and `resolveListenHost` falls through to `127.0.0.1`. That is precisely the
 * configuration a test process should have — a loopback listener on a port nobody else holds.
 */
export const VERIFY_NEUTRALIZED_LISTENER_ENV: Readonly<Record<string, string>> = Object.freeze({
  KANBAN_FLEET_PORT: "",
  KANBAN_FLEET_HOST: "",
  KANBAN_GIT_HTTP_PORT: "",
  KANBAN_GIT_HTTP_HOST: "",
  // Without this, a board running `KANBAN_FLEET_INSECURE=1` would push the test listeners
  // onto 0.0.0.0 — a wider bind than the suite asked for, on a machine running other agents.
  KANBAN_FLEET_INSECURE: "",
});

/**
 * Overlay {@link VERIFY_NEUTRALIZED_LISTENER_ENV} onto a verify/install subprocess env.
 *
 * Call this at EVERY site that spawns the verify script — the pre-merge gate and the
 * base-branch health probe both do, and a pin leaking into either one produces the same
 * phantom failure, attributed to a branch in one case and to the base in the other.
 */
export function withNeutralizedListenerEnv(
  env: Record<string, string> = {},
): Record<string, string> {
  return { ...env, ...VERIFY_NEUTRALIZED_LISTENER_ENV };
}
