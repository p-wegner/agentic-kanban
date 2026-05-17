import { apiFetch } from "../lib/api.js";
import type { ApprovalRequest } from "../lib/useBoardEvents.js";

interface Props {
  requests: ApprovalRequest[];
  onResolve: (id: string) => void;
}

type Decision = "allow" | "deny" | "allow_session" | "deny_session";

async function resolve(id: string, decision: Decision) {
  await apiFetch(`/api/approvals/${id}`, {
    method: "PUT",
    body: JSON.stringify({ decision }),
  });
}

export function ApprovalDialog({ requests, onResolve }: Props) {
  if (requests.length === 0) return null;

  const req = requests[0];

  const toolInputPreview = (() => {
    try {
      const s = JSON.stringify(req.toolInput, null, 2);
      return s.length > 800 ? s.slice(0, 800) + "\n..." : s;
    } catch {
      return String(req.toolInput);
    }
  })();

  const handle = async (decision: Decision) => {
    await resolve(req.id, decision).catch(() => {});
    onResolve(req.id);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-2">
          <span className="text-amber-500">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </span>
          <h2 className="font-semibold text-gray-900">Permission Request</h2>
          {requests.length > 1 && (
            <span className="ml-auto text-xs text-gray-400">{requests.length} pending</span>
          )}
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-700">
            The agent wants to use <span className="font-mono font-semibold text-gray-900 bg-gray-100 px-1 rounded">{req.toolName}</span>
          </p>

          <div className="bg-gray-50 rounded border border-gray-200 p-3">
            <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all max-h-48 overflow-y-auto font-mono">{toolInputPreview}</pre>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex flex-wrap gap-2 justify-end">
          <button
            onClick={() => handle("deny_session")}
            className="px-3 py-1.5 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Deny session
          </button>
          <button
            onClick={() => handle("deny")}
            className="px-3 py-1.5 text-sm rounded border border-red-300 text-red-700 hover:bg-red-50 transition-colors"
          >
            Deny once
          </button>
          <button
            onClick={() => handle("allow_session")}
            className="px-3 py-1.5 text-sm rounded border border-green-300 text-green-700 hover:bg-green-50 transition-colors"
          >
            Allow session
          </button>
          <button
            onClick={() => handle("allow")}
            className="px-3 py-1.5 text-sm rounded bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
