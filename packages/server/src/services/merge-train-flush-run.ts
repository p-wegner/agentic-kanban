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
