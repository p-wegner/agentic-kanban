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
 * The DB-LOCATION overrides a verify/install subprocess must not inherit either (#1041 gate).
 *
 * Same failure class as the listener pins above, one precedence level higher and considerably
 * worse. `resolveDbLocation` puts `KANBAN_DB_URL` (and its legacy alias `DB_URL`) FIRST — above
 * `AGENTIC_KANBAN_DIR`, above the in-checkout probe, and above the #231 test-runner throwaway
 * redirect. The board sets `KANBAN_DB_URL=file:<home>/.agentic-kanban/kanban.db` in the
 * environment it launches sessions with, and `runSetupScript` spawns with `{ ...process.env,
 * ...options.env }` — so the gate's own `AGENTIC_KANBAN_DIR: gateDataDir` isolation, whose entire
 * purpose is #231, was silently outranked and the gate's vitest workers resolved the LIVE board
 * database.
 *
 * Measured on this branch, 2026-09-05: 13 failures in a file-scoped gate run, all of them
 * phantom. `data-dir.test.ts` (5) asserts the precedence itself and clears `DB_URL` but not the
 * post-#615 canonical name, so every case resolved the real board; `backup.test.ts` (5) read 29
 * projects where its fixture had seeded 2 — and its round-trip case wipes and restores what it
 * opened; `startup-git-service-injection` (1) iterated 29 real repo rows where its comment says
 * "the suite's DB is the real (empty) one". Clearing `KANBAN_DB_URL` makes all 13 pass unchanged.
 *
 * Blanked rather than deleted for the same reason as above — a spread cannot express a deletion —
 * and blank is read as absent here by construction: `resolveDbLocation` selects with `||`, so an
 * empty string falls through to the next precedence level, which is the gate's own
 * `AGENTIC_KANBAN_DIR` (and, for any spawn site that sets none, the #231 throwaway).
 */
export const VERIFY_NEUTRALIZED_DB_LOCATION_ENV: Readonly<Record<string, string>> = Object.freeze({
  KANBAN_DB_URL: "",
  // #615's pre-rename alias. Neutralizing only the canonical name would leave the identical hole
  // open to any board still configured the old way.
  DB_URL: "",
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

/**
 * The ONLY variables the base-branch health probe's children may inherit from the board process
 * (#1231) — matched case-insensitively, because Windows spells `Path`/`PATH` and `Temp`/`TEMP`
 * however the parent happened to.
 *
 * Why an allowlist and not a longer blanklist: the probe is the one full-suite signal behind
 * `pnpm promote` and behind the `iterate` posture's promise that the FULL suite runs nightly on
 * the base. `runSetupScript` spreads `options.env` over `process.env`, so whatever
 * `KANBAN_TEST_*` / `KANBAN_IMPACT_*` / `KANBAN_ARCH_CHANGED_FILES` / `KANBAN_RETRY_TEST_FILES`
 * the board process carries reaches `scripts/test-mine.mjs` unchanged and turns the "full" probe
 * into a scoped or selector run — which then records a green that `promote` reads as a
 * full-suite verdict. The red sweep rows of 2026-09-18/19 carried
 * `[test:mine] added 1 NEW test file(s) from the diff on top of the selection`, a line only the
 * impact-selector path prints. A blanklist can only name the vars that exist today; the next
 * scoping knob is invisible to it by construction.
 *
 * What is here is what the shell, node, pnpm and git need to run at all: process location
 * (PATH, PATHEXT, ComSpec, SystemRoot, windir), home and profile dirs (pnpm's store, the npm
 * cache, git config), temp dirs, the Windows app-data dirs pnpm keeps its state under,
 * `PNPM_HOME` and pnpm's own `npm_execpath` (which `scripts/pnpm-exec.mjs` re-invokes), proxies
 * and CA certs for an install, `CI`, locale and timezone.
 *
 * Deliberately NOT here: any `KANBAN_*` (the neutralisers and the probe's own resource vars are
 * layered on explicitly by {@link buildBaseProbeEnv}), `NODE_ENV` (a `production` board would
 * skip devDependencies in the clone's install), `VITEST*`, `AGENTIC_KANBAN_DIR`, and anything
 * else that configures THIS board rather than the machine.
 */
export const BASE_PROBE_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // process location / shell
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "SYSTEMDRIVE",
  "SHELL",
  // identity + home (pnpm store, npm cache, git config)
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "USERNAME",
  "LOGNAME",
  // temp
  "TEMP",
  "TMP",
  "TMPDIR",
  // Windows app-data (pnpm state, npm cache, node-gyp) and the XDG equivalents
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  // pnpm / node
  "PNPM_HOME",
  "NPM_EXECPATH",
  "NPM_CONFIG_USERCONFIG",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_OPTIONS",
  // network, for the clone's install
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  // ci / locale
  "CI",
  "LANG",
  "LC_ALL",
  "TZ",
]);

/**
 * Build the base-branch health probe's child environment FROM SCRATCH (#1231): the allowlisted
 * subset of `source` (the board process env by default), then the listener and DB-location
 * neutralisers, then `extra` — the resource vars and, on the flake retry, `KANBAN_RETRY_TEST_FILES`,
 * which is the ONLY scoping key a probe child may ever carry, and only on that path.
 *
 * Pair it with `runSetupScript(..., { inheritEnv: false })`, or the runner spreads the result
 * back over `process.env` and the allowlist is decoration.
 */
export function buildBaseProbeEnv(
  extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = new Set(BASE_PROBE_ENV_ALLOWLIST.map((k) => k.toUpperCase()));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    ...VERIFY_NEUTRALIZED_LISTENER_ENV,
    ...VERIFY_NEUTRALIZED_DB_LOCATION_ENV,
    ...extra,
  };
}
