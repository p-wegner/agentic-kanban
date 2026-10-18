// Registration handshake + capability declaration split out of worker-daemon.ts (#1605); re-exported there.
import { readFileSync } from "node:fs";
import { platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_PROTOCOL_VERSION, type WorkerCapabilities, type WorkerDoctorSummary, type WorkerProfileAttestation } from "@agentic-kanban/shared/lib/worker-protocol";
import type { WorkerToolchainInstallInfo } from "@agentic-kanban/shared/lib/worker-toolchain-install";
import type { WorkerIdentity } from "./worker-state.js";
import { readWorkerCapacity } from "./worker-resources.js";
import { packageManagersField, toolchainsField } from "../cli/commands/worker-doctor-git-prereqs.js";
import { sameNamedNotice } from "./worker-name.js";
import type { WorkerDaemonOptions } from "./worker-daemon.js";

/**
 * What this machine declares about itself, on every registration AND every beat (#754).
 *
 * `profiles` (#1027) rides the same channel: a login can be added, removed or run out of quota,
 * and a value frozen at pairing time would stay a claim the board acts on after it stopped being true.
 */
export function capabilitiesOf(
  opts: WorkerDaemonOptions,
  profiles?: WorkerProfileAttestation[],
  providerNotice?: string,
  doctor?: WorkerDoctorSummary,
  toolchainInstall?: WorkerToolchainInstallInfo, verify?: WorkerCapabilities["verify"], workRoot?: string, unattested?: WorkerCapabilities["unattestedProfiles"],
): WorkerCapabilities {
  return {
    ...(toolchainInstall ? { toolchainInstall } : {}), ...(verify ? { verify } : {}),
    ...(providerNotice ? { providerNotice } : {}),
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.providers ? { providers: opts.providers } : {}),
    ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
    // #910: this machine's live headroom (Tier 0 only: one sync os.freemem() read, cheap for every beat; never throws)
    capacity: readWorkerCapacity(workRoot), ...(opts.harness ? { harnessMode: opts.harness.mode } : {}), // #1451
    ...(profiles && profiles.length > 0 ? { profiles } : {}), ...(unattested && unattested.length > 0 ? { unattestedProfiles: unattested } : {}),
    // #1369/#1382: package managers + toolchains this machine has, so placement can name what a project needs.
    ...packageManagersField(), ...toolchainsField(),
    ...(doctor ? { doctor } : {}),
  };
}

/** This build's own version â€” the same value `--version` reports. Never fabricated. */
export function resolveWorkerVersion(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let up = 0; up < 5; up++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "agentic-kanban" && pkg.version) return pkg.version;
      } catch {
        /* no manifest at this level */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** A registration the board refused for a reason retrying cannot fix (#754). */
export class WorkerRegistrationRefused extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorkerRegistrationRefused";
  }
}

export async function registerWithBoard(
  opts: WorkerDaemonOptions,
  boardUrl: string,
  name: string,
  attestedProfiles?: WorkerProfileAttestation[],
  doctor?: WorkerDoctorSummary,
): Promise<WorkerIdentity> {
  if (!opts.pairingToken) {
    throw new Error(
      `Worker is not paired with ${boardUrl} and no --token was given. ` +
      `Mint one on the board (POST /api/workers/pairing-token or 'worker pair') and pass it via --token.`,
    );
  }
  const res = await fetch(`${boardUrl}/api/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingToken: opts.pairingToken,
      name,
      os: platform(),
      arch: arch(),
      labels: opts.labels,
      providers: opts.providers,
      maxConcurrency: opts.maxConcurrency,
      // #1027: attested profile NAMES, so a restricted project can consider this machine
      // from its very first heartbeat rather than only after the next one lands.
      ...(attestedProfiles && attestedProfiles.length > 0 ? { profiles: attestedProfiles } : {}),
      ...(doctor ? { doctor } : {}),
      // #754: the handshake. A board that speaks a different protocol says so here, once,
      // instead of the mismatch surfacing later as dropped "malformed" messages.
      protocolVersion: WORKER_PROTOCOL_VERSION,
      workerVersion: resolveWorkerVersion(),
    }),
  });
  const body = await res.json().catch(() => ({})) as {
    workerId?: string;
    workerToken?: string;
    error?: string;
    boardProtocolVersion?: number; sameNamed?: { id: string }[];
    boardId?: string; // #1337
  };
  if (!res.ok || !body.workerId || !body.workerToken) {
    const detail = body.error ?? "unexpected response";
    // 409 = the board understood us and refuses this build. Retrying is pointless, so it
    // is a distinct error type the caller can turn into a clean non-zero exit.
    if (res.status === 409) {
      throw new WorkerRegistrationRefused(
        `Board at ${boardUrl} refuses this worker build: ${detail} ` +
          `(worker speaks protocol ${WORKER_PROTOCOL_VERSION}, board speaks ${body.boardProtocolVersion ?? "?"})`,
        res.status,
      );
    }
    throw new Error(`Registration failed (${res.status}): ${detail}`);
  }
  if (body.sameNamed?.length) (opts.log ?? console.log)(sameNamedNotice(name, body.sameNamed)); // #1390
  return { workerId: body.workerId, workerToken: body.workerToken, name, ...(body.boardId ? { boardId: body.boardId } : {}) };
}
