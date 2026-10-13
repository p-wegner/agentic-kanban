import { useState } from "react";
import { apiPost } from "../lib/api.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { useConnectCodeQuery } from "../hooks/useWorkerFleetQueries.js";
import { CopyCommand } from "./CopyCommand.js";

type Target = "windows" | "unix" | "wsl";
const TARGET_LABEL: Record<Target, string> = { windows: "Windows (PowerShell)", unix: "Linux / macOS", wsl: "WSL (inside the distro)" };

/** `POST /api/workers/connect-code` — #1442. The markdown is the same text the agent URL serves. */
interface MintedConnectCode {
  code: string;
  expiresAt: string;
  agentUrl: string;
  agentPrompt: string;
  markdown: string;
  fleetNote?: string | null;
}

function download(filename: string, text: string): void {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

const buttonClass =
  "rounded border border-gray-300 dark:border-gray-600 px-2 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700";

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button type="button" onClick={copy} className={buttonClass}>
      {copied ? "Copied" : label}
    </button>
  );
}

const inputClass = "w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs";

/**
 * "Let an agent connect the machine" (#1442): choices -> mint a one-time connect code -> copy the
 * runbook as Markdown, download `connect.md`, or hand the agent the one-line prompt with the URL.
 * Shows the agent's progress reports live.
 */
export function WorkerConnectAgentPanel({ fleetUrl }: { fleetUrl?: string | null }) {
  const [target, setTarget] = useState<Target>("windows");
  const [workerName, setWorkerName] = useState("");
  const [labels, setLabels] = useState("");
  const [maxConcurrency, setMaxConcurrency] = useState("");
  const [profileAlias, setProfileAlias] = useState("");
  const [toolchainInstall, setToolchainInstall] = useState("");
  const [boardUrls, setBoardUrls] = useState("");
  const [minted, setMinted] = useState<MintedConnectCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: state } = useConnectCodeQuery(minted?.code ?? null);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      setMinted(
        await apiPost<MintedConnectCode>("/api/workers/connect-code", {
          os: target,
          workerName,
          labels,
          maxConcurrency,
          profileAlias,
          toolchainInstall,
          boardUrls,
          ...(fleetUrl ? { fleetUrl } : {}),
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!minted) return;
    try {
      await apiPost(`/api/workers/connect-code/${encodeURIComponent(minted.code)}/revoke`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 p-3" data-testid="worker-connect-agent">
      <div className="text-sm font-medium text-ink dark:text-stone-100">Let an agent connect the machine</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        Mints a one-time link (single pairing, expires with its pairing token) that an agent on the new machine fetches and follows. It
        carries only a pairing token.
      </div>
      {error && <div className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <label>
          Target
          <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value as Target)}>
            {(Object.keys(TARGET_LABEL) as Target[]).map((key) => (
              <option key={key} value={key}>
                {TARGET_LABEL[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Worker name
          <input className={inputClass} value={workerName} onChange={(e) => setWorkerName(e.target.value)} placeholder="hostname" />
        </label>
        <label>
          Labels (csv)
          <input className={inputClass} value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="docker,windows" />
        </label>
        <label>
          Max concurrency
          <input className={inputClass} value={maxConcurrency} onChange={(e) => setMaxConcurrency(e.target.value)} placeholder="2" />
        </label>
        <label>
          Profile alias
          <input className={inputClass} value={profileAlias} onChange={(e) => setProfileAlias(e.target.value)} placeholder="default=anth" />
        </label>
        <label>
          Toolchain install
          <select className={inputClass} value={toolchainInstall} onChange={(e) => setToolchainInstall(e.target.value)}>
            <option value="">(worker default: never)</option>
            <option value="never">never</option>
            <option value="ask">ask</option>
            <option value="auto">auto</option>
          </select>
        </label>
        <label className="col-span-2">
          Extra board URLs (csv — LAN first, tailnet fallback)
          <input className={inputClass} value={boardUrls} onChange={(e) => setBoardUrls(e.target.value)} placeholder="http://100.x.y.z:3003" />
        </label>
      </div>
      <button
        onClick={mint}
        disabled={busy}
        className="mt-2 rounded bg-accent-600 px-3 py-1.5 text-sm text-white hover:bg-accent-700 disabled:opacity-50"
      >
        {minted ? "Mint a new link" : "Mint agent link"}
      </button>

      {minted && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <CopyButton label="Copy agent prompt" text={minted.agentPrompt} />
            <CopyButton label="Copy as Markdown" text={minted.markdown} />
            <button type="button" onClick={() => download("connect.md", minted.markdown)} className={buttonClass}>
              Download connect.md
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={state?.status !== undefined && state.status !== "active"}
              className="rounded border border-red-300 dark:border-red-800 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
            >
              Revoke
            </button>
          </div>
          <CopyCommand command={minted.agentPrompt} />
          {minted.fleetNote && <div className="text-xs text-amber-700 dark:text-amber-300">{minted.fleetNote}</div>}
          <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="connect-code-state">
            Link {state?.status ?? "active"}
            {state ? ` · fetched ${state.fetches}/${state.maxFetches}` : ""}
          </div>
          {state && state.progress.length > 0 && (
            <ul className="space-y-0.5 text-xs" data-testid="connect-code-progress">
              {state.progress.map((p, i) => (
                <li key={`${p.at}-${i}`} className={p.status === "ok" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-300"}>
                  {p.status === "ok" ? "✓" : "✗"} <code>{p.step}</code> {p.output}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
