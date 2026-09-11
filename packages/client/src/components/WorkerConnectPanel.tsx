import { useEffect, useState } from "react";
import { apiFetch, apiPost } from "../lib/api.js";
import { formatRelativeTime } from "../lib/formatRelativeTime.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

interface WorkerConnectStep {
  title: string;
  detail: string;
  commands: string[];
  where: "worker" | "board" | "either";
}

interface ConnectInfo {
  fleetConfigured: boolean;
  fleetPort: number | null;
  fleetHost: string;
  gitHttpPort: number;
  gitHttpHost: string;
  boardWorkerVersion: string | null;
  boardUrl: string;
  steps: WorkerConnectStep[];
}

const PLACEHOLDER_TOKEN = "<pairing-token>";

const WHERE_LABEL: Record<WorkerConnectStep["where"], string> = {
  worker: "on the WORKER machine",
  board: "on the BOARD machine",
  either: "either machine",
};

/**
 * Connect tab (#1089): mint a pairing token and get the exact runbook to connect another
 * machine as a fleet worker. The steps come from `GET /api/workers/connect-info`, which
 * shares `buildWorkerConnectSteps` with `worker instructions` — the CLI and this tab can
 * never drift into two different sets of commands.
 */
export function WorkerConnectPanel() {
  const [info, setInfo] = useState<ConnectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ pairingToken: string; expiresAt: string } | null>(null);
  const [minting, setMinting] = useState(false);

  useEffect(() => {
    apiFetch<ConnectInfo>("/api/workers/connect-info")
      .then(setInfo)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const mintPairingToken = async () => {
    setMinting(true);
    setError(null);
    try {
      setPairing(await apiPost<{ pairingToken: string; expiresAt: string }>("/api/workers/pairing-token"));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setMinting(false);
    }
  };

  const token = pairing?.pairingToken ?? PLACEHOLDER_TOKEN;
  const withToken = (line: string) => line.split(PLACEHOLDER_TOKEN).join(token);

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium text-ink dark:text-stone-100">Pair a new worker</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Mint a single-use token, then follow the runbook below on the other machine.
            </div>
          </div>
          <button
            onClick={mintPairingToken}
            disabled={minting}
            className="shrink-0 rounded bg-accent-600 px-3 py-1.5 text-sm text-white hover:bg-accent-700 disabled:opacity-50"
          >
            Mint token
          </button>
        </div>
        {pairing && (
          <div className="mt-3 space-y-1">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Expires {formatRelativeTime(pairing.expiresAt)} — single use. Filled into the commands below.
            </div>
            <code className="block break-all rounded bg-gray-100 dark:bg-gray-800 px-2 py-1.5 text-xs text-ink dark:text-stone-100">
              {pairing.pairingToken}
            </code>
          </div>
        )}
      </div>

      {info && (
        <div className="rounded border border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-600 dark:text-gray-300">
          <div className="font-medium text-ink dark:text-stone-100 mb-1">Fleet listener config</div>
          {info.fleetConfigured ? (
            <>
              Fleet port <code>{info.fleetPort}</code> on <code>{info.fleetHost}</code> · git transport port{" "}
              <code>{info.gitHttpPort}</code> on <code>{info.gitHttpHost}</code>
              {info.boardWorkerVersion && (
                <>
                  {" "}
                  · board build <code>{info.boardWorkerVersion}</code>
                </>
              )}
            </>
          ) : (
            <>
              No fleet listener is configured yet — set <code>KANBAN_FLEET_PORT</code> (and optionally{" "}
              <code>KANBAN_FLEET_HOST</code>) on the board machine before a remote worker can connect. Same-machine
              workers can still pair via <code>--shares-filesystem</code>.
            </>
          )}
        </div>
      )}

      {info?.steps.map((step, i) => (
        <div key={step.title} className="rounded border border-gray-200 dark:border-gray-700 p-3">
          <div className="text-sm font-medium text-ink dark:text-stone-100">
            {i + 1}. {step.title}{" "}
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">({WHERE_LABEL[step.where]})</span>
          </div>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">{step.detail}</p>
          {step.commands.length > 0 && (
            <pre className="mt-2 overflow-x-auto rounded bg-gray-100 dark:bg-gray-800 px-2 py-1.5 text-xs text-ink dark:text-stone-100">
              {step.commands.map(withToken).join("\n")}
            </pre>
          )}
        </div>
      ))}

      <div className="rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-200">
        Never <code>KANBAN_HOST=0.0.0.0</code> — the board API has no authentication. Only the fleet and git-transport
        ports above are safe to expose, and each authenticates every request with a bearer token. Keep the board on a
        trusted network (LAN/VPN/Tailscale), never the open internet.
      </div>
    </div>
  );
}
