/**
 * The seam between the production train runner (`merge-queue-train.ts`) and flush mode (#1463,
 * decision 020 part 2). `merge-train-flush.ts` holds the pure pieces (tag shape, sequence,
 * posture refusal); this holds what the runner needs to RUN a flush: the gate script, the
 * post-landing tag, and the hand-off to the flush service that owns the record.
 *
 * Kept out of `merge-queue-train.ts` on purpose — that file sits within a dozen lines of the
 * god-module ceiling, so the runner only threads a `FlushRunSpec` through and calls
 * {@link finishFlushRun}.
 */
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { formatFlushTag, nextFlushSeq, tagFlushLanding } from "./merge-train-flush.js";
import { trainDateStamp, type TrainRunResult } from "./merge-train.service.js";

/** The flush gate (decision 020 item 1): `check:arch` + `typecheck`, no suite. Overridable via `queue_flush_gate_<id>`. */
export const DEFAULT_FLUSH_GATE_SCRIPT = "pnpm check:arch && pnpm typecheck";

/** `typecheck` alone is the only sanctioned weakening: typecheck stays mandatory (decision 020 item 1). */
const TYPECHECK_ONLY_FLUSH_GATE_SCRIPT = "pnpm typecheck";

export interface ResolvedFlushGate {
  script: string;
  /** Null for the default gate; otherwise the script that actually runs, for every operator-facing text. */
  override: string | null;
  /** Set when the pref was not on the allowlist and the default was used instead. */
  warning?: string;
}

/**
 * `queue_flush_gate_<id>` -> the gate to run (#1742). Allowlist: `default` | `arch+typecheck` |
 * `typecheck` (or the exact default / typecheck-only script). Anything else — `echo ok`, a
 * script without typecheck — fails CLOSED to the default with a warning, like `queue_flush`.
 */
export function resolveFlushGate(raw: string | null | undefined): ResolvedFlushGate {
  const v = (raw ?? "").trim();
  const key = v.toLowerCase().replace(/\s+/g, " ");
  if (!v || key === "default" || key === "arch+typecheck" || v === DEFAULT_FLUSH_GATE_SCRIPT) {
    return { script: DEFAULT_FLUSH_GATE_SCRIPT, override: null };
  }
  if (key === "typecheck" || v === TYPECHECK_ONLY_FLUSH_GATE_SCRIPT) {
    return { script: TYPECHECK_ONLY_FLUSH_GATE_SCRIPT, override: TYPECHECK_ONLY_FLUSH_GATE_SCRIPT };
  }
  return {
    script: DEFAULT_FLUSH_GATE_SCRIPT, override: null,
    warning: `queue_flush_gate "${v}" is not one of default | arch+typecheck | typecheck — using the default gate (${DEFAULT_FLUSH_GATE_SCRIPT})`,
  };
}

export interface FlushLanding {
  label: string;
  run: TrainRunResult;
  /** `flush/<date>-N`; absent when nothing landed. */
  tag?: string;
}

export interface FlushRunSpec {
  /** Run in place of the project's verify command, on a worker per `verify_placement`. */
  gateScript: string;
  /** Persisted-time injection, `now?: string`. */
  now?: string;
  /** Called once per train run, landed or not, after the tag is cut. Throwing never fails the train. */
  onFinished: (landing: FlushLanding) => Promise<void>;
}

/** Tag the landing (when something landed) and hand the outcome to the flush service. */
export async function finishFlushRun(spec: FlushRunSpec, repoPath: string, label: string, run: TrainRunResult): Promise<void> {
  let tag: string | undefined;
  if (run.landed.length > 0 && run.mergeSha) {
    const dateStamp = trainDateStamp(spec.now);
    const listed = await gitExecOrThrow(["tag", "--list", `flush/${dateStamp}-*`], { cwd: repoPath });
    const existing = listed.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    tag = formatFlushTag(dateStamp, nextFlushSeq(dateStamp, existing));
    await tagFlushLanding(repoPath, tag, run.mergeSha);
  }
  await spec.onFinished({ label, run, tag });
}
