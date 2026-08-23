// Types for server-dev-proxy.mjs, so the guard suite that pins the board's port
// ladder against the REAL proxy can import it without `tsc` falling back to
// `any` (TS7016).
//
// Hand-written rather than generated, matching `security-scan.d.mts` (#827):
// the script is a plain .mjs with no build step because `pnpm dev` runs it
// directly. Only the exported surface is described; drift is caught at import
// time by `board-port-ladder-single-source.test.ts`, which executes the real
// module. That suite previously carried an `@ts-expect-error` here, which
// suppressed exactly the mismatch it exists to catch (#835).

import type { ChildProcess } from "node:child_process";
import type { Server } from "node:http";

/** The public port the board is reachable on: the first of the KANBAN_/SERVER_/PORT ladder that parses. */
export declare function resolvePublicServerPort(env?: NodeJS.ProcessEnv): number;

/** The internal port the backend is started on for a given public port. */
export declare function preferredInternalPort(publicPort: number): number;

/** The env the watched backend is spawned with — every port var pinned to the resolved pair. */
export declare function buildBackendEnv(
  env: NodeJS.ProcessEnv,
  publicPort: number,
  internalPort: number,
): NodeJS.ProcessEnv;

/** An HTTP server that proxies (and retries) to the backend while `tsx watch` restarts it. */
export declare function createStableDevProxy(options: {
  publicHost?: string;
  backendHost?: string;
  publicPort: number;
  backendPort: number;
  retryTimeoutMs?: number;
  retryDelayMs?: number;
}): Server;

/** Promise wrapper around `server.listen`, rejecting on a listen error rather than throwing globally. */
export declare function listen(server: Server, port: number, host?: string): Promise<void>;

/** The first free port at or near `preferredPort`; throws when none is free within ±100. */
export declare function findAvailableInternalPort(preferredPort: number, host?: string): Promise<number>;

/** Spawn `tsx watch` for the server package on the internal port. */
export declare function spawnWatchedBackend(args: {
  serverDir: string;
  publicPort: number;
  internalPort: number;
  env?: NodeJS.ProcessEnv;
}): ChildProcess;

/** Swallow the socket errnos that mean "the peer went away"; rethrow everything else. */
export declare function installSocketErrorGuard(proc?: NodeJS.Process): void;
