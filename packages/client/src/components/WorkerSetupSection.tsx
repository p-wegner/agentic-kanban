import type { WorkerDoctorSummary, WorkerProfileAttestation } from "@agentic-kanban/shared/lib/worker-protocol";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { workerSetupState, type WorkerSetupInput } from "../lib/workerSetup.js";
import { CopyCommand } from "./CopyCommand.js";

const CHECK_STYLE = {
  pass: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  fail: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  skip: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  unknown: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
} as const;

const CREDENTIAL_STYLE = {
  ok: CHECK_STYLE.pass,
  expired: CHECK_STYLE.warn,
  missing: CHECK_STYLE.fail,
  unknown: CHECK_STYLE.unknown,
} as const;

interface Props extends WorkerSetupInput {
  doctor?: WorkerDoctorSummary;
  attestedProfiles?: WorkerProfileAttestation[];
}

/**
 * The per-worker "Setup" section (#1370): the worker's own doctor results as a checklist (with the
 * fix command and a copy button), its providers with credential state and harness mode, and the
 * profiles it attests. Passes are folded away — the point is what is left to do.
 */
export function WorkerSetupSection(props: Props) {
  const state = workerSetupState(props);
  const { doctor, attestedProfiles } = props;
  const passes = (doctor?.checks ?? []).filter((c) => c.status === "pass");
  return (
    <div className="mt-3 rounded border border-gray-200 dark:border-gray-700 p-2.5" data-testid="worker-setup">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium text-ink dark:text-stone-100">Setup</span>
        {state.needsSetup ? (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/40 dark:text-red-300">
            needs setup — {state.reasons.join(", ")}
          </span>
        ) : (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-900/40 dark:text-green-300">
            ready
          </span>
        )}
        {doctor?.harnessMode && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            harness: {doctor.harnessMode}
          </span>
        )}
        {doctor?.checkedAt && (
          <span className="text-gray-400 dark:text-gray-500">checked {formatRelativeTime(doctor.checkedAt)}</span>
        )}
      </div>

      {!doctor && (
        <div className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          This worker has not sent its doctor results (an older build, or it has not finished its first check).
          Run <code>agentic-kanban-worker doctor</code> on it.
        </div>
      )}

      {state.providers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {state.providers.map((p) => (
            <span key={p.provider} className={`rounded px-1.5 py-0.5 ${CREDENTIAL_STYLE[p.credential]}`}>
              {p.provider}: {p.credential}
            </span>
          ))}
        </div>
      )}

      {(attestedProfiles?.length ?? 0) > 0 && (
        <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
          Attested profiles:{" "}
          {attestedProfiles!.map((p) => (
            <span
              key={`${p.provider}:${p.name}`}
              className={`mr-1 rounded px-1.5 py-0.5 ${p.credentials ? CHECK_STYLE.warn : CHECK_STYLE.skip}`}
            >
              {p.provider}/{p.name}
              {p.credentials ? ` (${p.credentials})` : ""}
            </span>
          ))}
        </div>
      )}

      {[...state.failing, ...state.warning].map((c) => (
        <div key={c.id} className="mt-2 text-xs">
          <div className="flex items-start gap-2">
            <span className={`shrink-0 rounded px-1.5 py-0.5 ${CHECK_STYLE[c.status]}`}>{c.status}</span>
            <span className="text-ink dark:text-stone-100">
              <span className="font-medium">{c.id}</span> — {c.message}
            </span>
          </div>
          {c.fix && (
            <div className="mt-1 pl-1">
              <CopyCommand command={c.fix} />
            </div>
          )}
        </div>
      ))}

      {passes.length > 0 && (
        <details className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer">{passes.length} passing check{passes.length === 1 ? "" : "s"}</summary>
          <ul className="mt-1 space-y-0.5">
            {passes.map((c) => (
              <li key={c.id}>
                <span className={`mr-1 rounded px-1 py-0.5 ${CHECK_STYLE.pass}`}>pass</span>
                {c.id} — {c.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
