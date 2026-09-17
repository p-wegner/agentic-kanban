/**
 * Train-scoped review (#1194, proposal 2026-08-25 §4 "Review on the train").
 *
 * Under `fast` (`reviewMode: "train-only"`) the per-ticket auto-review is skipped, and until
 * this file existed nothing reviewed the train instead — the posture's own summary promised
 * "reviews the train instead" while the train only gated. Now ONE reviewer session runs per
 * assembled train, inside the gate's staging worktree, over the assembled diff vs the base,
 * with every member's number, title and acceptance criteria rendered into the `code-review`
 * skill's `{{members}}` placeholder. Gate ONCE, review ONCE.
 *
 * Three rules, each the answer to a specific way this could have gone wrong:
 *
 *  - **Findings attach to the member ticket whose files they touch.** The reviewer is asked to
 *    name the member for every finding; when it names none (or names one that is not on this
 *    train), the file path decides — each member's changed-file set is known from the queue —
 *    and a finding that matches no member's files stays unattributed on the train's own
 *    evidence rather than being pinned on an arbitrary ticket.
 *  - **A blocking finding pulls its member into a siding, it never fails the train.** The gate
 *    already proved the assembled tree green; a CRITICAL/MAJOR finding on one member's ticket
 *    says nothing about the others. `runMergeTrain` re-assembles WITHOUT the sided members and
 *    lands the rest (no re-gate — removing a branch's changes is not something the gate needs to
 *    re-verify). In `sprint` the same finding is a comment only — proposal §4: "the attribution
 *    becomes a comment on the member's ticket plus a red-debt entry instead of a rejection".
 *  - **A review that could not run lands the train unreviewed and SAYS SO.** Failing the gate
 *    for a reviewer outage would bisect a green batch N times over to reach the same outage,
 *    and the result would be zero merges rather than zero reviews. The evidence records
 *    `review: { status: "failed" }` and the log names it; an operator who wants a reviewer outage
 *    to block landings puts the project on `standard`, where every ticket is reviewed on exit.
 *
 * The siding itself — the ticket comment, the `train-siding` tag, the `/turn` nudge and the
 * branch-tip re-admission — is #1192's `merge-train-siding.service.ts`. That branch is not in
 * this tree yet, so `recordTrainReviewSiding` below is the seam: it posts the finding as a
 * `merge-attempt` comment on the member ticket (the part a reviewer of the ticket needs
 * regardless) and is where `recordTrainSidingDrop` plugs in once #1192 lands.
 */
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { extractModelJson } from "@agentic-kanban/shared/lib/model-json";
import type { MergeTrainReviewEvidenceDto } from "@agentic-kanban/shared/types";
import { insertIssueComment } from "../repositories/issue-comments.repository.js";
import { getLeadIssueForMembersBlock } from "../repositories/workspace-issue-members.repository.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import { buildReviewContext } from "./phase-context.service.js";
import { buildMembersBlock, buildReviewPrompt } from "./review.service.js";
import { resolveProjectReviewMode } from "./review-mode-pref.js";
import type { RiskPosture } from "./risk-posture.service.js";

/** A generous budget: the review is the whole train's, and one is run per train, not per member. */
export const TRAIN_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;

export const TRAIN_REVIEW_SEVERITIES = ["CRITICAL", "MAJOR", "MINOR"] as const;
export type TrainReviewSeverity = (typeof TRAIN_REVIEW_SEVERITIES)[number];

export interface TrainReviewMember {
  workspaceId: string;
  branch: string;
  issueId: string;
  issueNumber: number | null;
  /** Files this member's branch changes vs the base — the attribution key for a finding that names no member. */
  changedFiles: string[];
}

export interface TrainReviewFinding {
  /** Null when neither the reviewer's member reference nor the file matched a member on this train. */
  workspaceId: string | null;
  severity: TrainReviewSeverity;
  file: string | null;
  message: string;
}

export interface TrainReviewVerdict {
  findings: TrainReviewFinding[];
  /** One entry per member with at least one CRITICAL/MAJOR finding — the members to side. */
  blocking: Array<{ workspaceId: string; reason: string }>;
  /** The reviewer's own one-paragraph summary, when it gave one. */
  summary: string | null;
}

/**
 * Should this train be reviewed, and does a blocking finding side its member? A pure prefMap
 * resolver, the same shape as `resolveProjectReviewMode` it builds on:
 *
 *  - `run` — `fast` (`train-only`), any posture with the explicit `review_mode=per-train` pref,
 *    and `sprint`. `sprint`'s `reviewMode: "none"` says no PER-TICKET review; §4 still gives the
 *    train one, non-blocking.
 *  - `blocking` — false under `sprint` (findings become comments), true otherwise.
 *  - `thorough` — `strict` would select the thorough skill, but `strict` never trains
 *    (`trainMaxSize: 1`), so in practice this is false; kept so an explicit per-train pref on a
 *    strict project gets the skill the posture asks for.
 */
export function resolveTrainReviewDecision(
  prefMap: Map<string, string>,
  projectId: string,
): { run: boolean; blocking: boolean; thorough: boolean; posture: RiskPosture; reason: string } {
  const decision = resolveProjectReviewMode(prefMap, projectId);
  const sprint = decision.posture.level === "sprint";
  if (decision.mode === "per-train") {
    return { run: true, blocking: true, thorough: decision.thorough, posture: decision.posture, reason: "review mode per-train" };
  }
  if (sprint) {
    return { run: true, blocking: false, thorough: false, posture: decision.posture, reason: "sprint posture: train review is advisory (comments only)" };
  }
  return {
    run: false, blocking: false, thorough: false, posture: decision.posture,
    reason: `posture ${decision.posture.level} reviews per ticket, not per train`,
  };
}

/**
 * The verdict protocol appended to the `code-review` skill's rendered prompt. The skill's own
 * per-ticket instructions (move the issue, fix in place) do not apply to a train — the reviewer
 * sits in a staging worktree that is deleted right after it exits, and the board decides what
 * happens to each member from the JSON below. Said explicitly, because the skill text above it
 * says the opposite.
 */
export function buildTrainReviewProtocol(members: TrainReviewMember[]): string {
  const refs = members.map((m) => `  - ${m.issueNumber != null ? `#${m.issueNumber}` : m.workspaceId} → branch \`${m.branch}\` (${m.changedFiles.length} file${m.changedFiles.length === 1 ? "" : "s"})`);
  return `## Train review protocol (overrides the per-ticket instructions above)

You are reviewing an ASSEMBLED MERGE TRAIN, not one ticket. This worktree is a temporary staging tree that is discarded when you exit.

- Do NOT edit files, do NOT commit, do NOT move any issue, do NOT call any board tool. Report only.
- Attribute EVERY finding to the member ticket whose change it is in. The members and their branches:
${refs.join("\n")}
- A blocking finding (CRITICAL or MAJOR) removes ONLY that member from this train; the others still land. So attribute carefully — a finding pinned on the wrong ticket blocks the wrong author.

End your reply with exactly one JSON object in a \`\`\`json fence, and nothing after it:

\`\`\`json
{
  "summary": "one paragraph",
  "findings": [
    { "member": "#123", "severity": "CRITICAL|MAJOR|MINOR", "file": "path/from/repo/root.ts", "message": "what is wrong and why it matters" }
  ]
}
\`\`\`

\`member\` is the ticket number (\`#123\`) or the branch name. An empty \`findings\` array means the train is clean.`;
}

/** Build the whole prompt: the `code-review` skill (with `{{members}}` rendered), then the train protocol. */
export async function buildTrainReviewPrompt(args: {
  database: Database;
  projectId: string;
  baseBranch: string;
  trainRef: string;
  members: TrainReviewMember[];
  precomputedContext: string | null;
  thorough: boolean;
}): Promise<{ prompt: string; model: string | null }> {
  const issueRows = await Promise.all(args.members.map((m) => getLeadIssueForMembersBlock(m.issueId, args.database).catch(() => undefined)));
  const membersBlock = buildMembersBlock(args.members.map((m, i) => ({
    issueNumber: m.issueNumber,
    title: issueRows[i]?.title ?? m.branch,
    description: issueRows[i]?.description ?? null,
  })));
  const leadIssueId = args.members[0]?.issueId ?? "";
  const { prompt, model } = await buildReviewPrompt(
    args.database, args.trainRef, args.baseBranch, leadIssueId, /* autoFix */ false, args.projectId,
    undefined, undefined, /* workspaceId */ `train:${args.trainRef}`,
    args.thorough ? "code-review-thorough" : "code-review", undefined, args.precomputedContext, membersBlock,
  );
  return { prompt: `${prompt}\n\n${buildTrainReviewProtocol(args.members)}`, model };
}

function normalizeSeverity(value: unknown): TrainReviewSeverity | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (TRAIN_REVIEW_SEVERITIES as readonly string[]).includes(upper) ? (upper as TrainReviewSeverity) : null;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

/** Resolve a reviewer's `member` reference: `#123`, `123`, a branch name, or a workspace id. */
function memberByRef(ref: unknown, members: TrainReviewMember[]): TrainReviewMember | undefined {
  if (typeof ref === "number") return members.find((m) => m.issueNumber === ref);
  if (typeof ref !== "string" || !ref.trim()) return undefined;
  const text = ref.trim();
  const num = /^#?(\d+)$/.exec(text);
  if (num) return members.find((m) => m.issueNumber === Number(num[1]));
  return members.find((m) => m.branch === text || m.workspaceId === text)
    ?? members.find((m) => text.includes(m.branch));
}

/** The member whose changed-file set contains `file` — unique, or nothing. */
function memberByFile(file: string | null, members: TrainReviewMember[]): TrainReviewMember | undefined {
  if (!file) return undefined;
  const wanted = normalizePath(file);
  const hits = members.filter((m) => m.changedFiles.some((f) => normalizePath(f) === wanted));
  // Two members touching one file is a real possibility on a train (they merged cleanly, so
  // different hunks); the reviewer's explicit reference is the only honest attribution then.
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Parse the reviewer's reply into attributed findings. Pure. A reply with no JSON at all is a
 * parse failure the caller reports as a failed review; a JSON block with malformed entries
 * drops those entries (a finding with no severity is not a finding) and keeps the rest.
 *
 * Attribution order: the reviewer's explicit `member`, then the file's unique owner, else null.
 * The explicit reference wins because the reviewer saw the hunk; the file set is the fallback
 * for a reviewer that forgot the field.
 */
export function parseTrainReviewVerdict(text: string, members: TrainReviewMember[]): TrainReviewVerdict {
  const raw = extractModelJson(text, { shape: "object", prefer: "last" }) as { summary?: unknown; findings?: unknown };
  const list = Array.isArray(raw.findings) ? raw.findings : [];
  const findings: TrainReviewFinding[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const severity = normalizeSeverity(e.severity);
    if (!severity) continue;
    const file = typeof e.file === "string" && e.file.trim() ? normalizePath(e.file) : null;
    const member = memberByRef(e.member, members) ?? memberByFile(file, members);
    const message = typeof e.message === "string" ? e.message.trim() : "";
    findings.push({ workspaceId: member?.workspaceId ?? null, severity, file, message: message || "(no message)" });
  }
  const blocking: TrainReviewVerdict["blocking"] = [];
  for (const m of members) {
    const mine = findings.filter((f) => f.workspaceId === m.workspaceId && f.severity !== "MINOR");
    if (mine.length === 0) continue;
    const reason = mine
      .map((f) => `${f.severity}${f.file ? ` ${f.file}` : ""}: ${f.message}`)
      .join("; ");
    blocking.push({ workspaceId: m.workspaceId, reason: `train review (#1194): ${reason}` });
  }
  return {
    findings,
    blocking,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : null,
  };
}

/** Render one member's findings as the ticket comment body. */
export function formatTrainReviewComment(args: {
  trainLabel: string;
  findings: TrainReviewFinding[];
  blocking: boolean;
  sided: boolean;
}): string {
  const lines = args.findings.map((f) => `- **${f.severity}**${f.file ? ` \`${f.file}\`` : ""}: ${f.message}`);
  const head = args.sided
    ? `The merge train \`${args.trainLabel}\` reviewed its assembled diff and found blocking issue(s) in this ticket's change. This member was pulled into a siding — the rest of the train landed without it. Fix the findings below and push; the branch rejoins the train once its tip moves.`
    : args.blocking
      ? `The merge train \`${args.trainLabel}\` reviewed its assembled diff and noted the following in this ticket's change (none blocking):`
      : `The merge train \`${args.trainLabel}\` reviewed its assembled diff and landed this ticket with the following findings recorded as known debt (sprint posture: review is advisory):`;
  return `${head}\n\n${lines.join("\n")}`;
}

export interface TrainReviewDeps {
  database?: Database;
  /** The one-shot agent runner; injected so the review can be tested without a CLI on the path. */
  invoke?: (prompt: string, opts: { timeout: number; cwd: string; model?: string; database: Database }) => Promise<string>;
  /** Injected for tests; defaults to the real diff builder against the staging worktree. */
  buildContext?: (args: { workingDir: string; baseRef: string }) => Promise<string | null>;
  now?: () => Date;
}

export interface TrainReviewRunResult {
  /** Members to pull into a siding — empty when the review is advisory (`sprint`) or clean. */
  sided: Array<{ workspaceId: string; reason: string }>;
  verdict: TrainReviewVerdict | null;
  evidence: MergeTrainReviewEvidenceDto;
}

/**
 * #1192 seam. Record that the train review sided `member`: today a `merge-attempt` comment on
 * the ticket carrying the findings (which the author needs whatever else happens). Once
 * `merge-train-siding.service.ts` (#1192) is in this tree, the call to add here is
 * `recordTrainSidingDrop(member, { reason, baseBranch, trainTipSha, repoPath }, { database, sendTurn })`
 * — its branch-tip re-admission rule is exactly right for a review finding too: the member is
 * withheld until its tip moves, then rejoins the next window. TODO(#1192).
 */
export async function recordTrainReviewSiding(
  member: Pick<TrainReviewMember, "workspaceId" | "issueId">,
  args: { trainLabel: string; findings: TrainReviewFinding[]; blocking: boolean; sided: boolean; now: string },
  database: Database,
): Promise<void> {
  await insertIssueComment({
    issueId: member.issueId,
    workspaceId: member.workspaceId,
    kind: "merge-attempt",
    author: "system",
    body: formatTrainReviewComment({ trainLabel: args.trainLabel, findings: args.findings, blocking: args.blocking, sided: args.sided }),
    payload: { eventType: "train-review", trainLabel: args.trainLabel, sided: args.sided, findings: args.findings },
    createdAt: args.now,
  }, database);
}

/**
 * Run ONE review over the assembled train in `gateWorktree` and turn its findings into
 * per-ticket comments plus the list of members to side. Never throws: a review that could not
 * run is reported through `evidence.status === "failed"` and sides nobody (see the module doc
 * for why that is the fail-open the train wants).
 */
export async function runTrainReview(
  args: {
    projectId: string;
    trainLabel: string;
    trainRef: string;
    baseBranch: string;
    gateWorktree: string;
    members: TrainReviewMember[];
    blocking: boolean;
    thorough: boolean;
  },
  deps: TrainReviewDeps = {},
): Promise<TrainReviewRunResult> {
  const database = deps.database ?? db;
  const invoke = deps.invoke ?? ((prompt, opts) => invokeClaudePrompt(prompt, opts));
  const buildContext = deps.buildContext ?? (({ workingDir, baseRef }) => buildReviewContext({ workingDir, baseRef, isDirect: false }));
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const tag = `[merge-train-review] ${args.trainLabel}`;

  let verdict: TrainReviewVerdict;
  try {
    const precomputedContext = await buildContext({ workingDir: args.gateWorktree, baseRef: args.baseBranch });
    const { prompt, model } = await buildTrainReviewPrompt({
      database, projectId: args.projectId, baseBranch: args.baseBranch, trainRef: args.trainRef,
      members: args.members, precomputedContext, thorough: args.thorough,
    });
    const reply = await invoke(prompt, { timeout: TRAIN_REVIEW_TIMEOUT_MS, cwd: args.gateWorktree, database, ...(model ? { model } : {}) });
    verdict = parseTrainReviewVerdict(reply, args.members);
  } catch (err) {
    const error = errorMessage(err).slice(0, 500);
    console.warn(`${tag}: review could not run — landing UNREVIEWED: ${error}`);
    return { sided: [], verdict: null, evidence: { status: "failed", error } };
  }

  const sidedIds = new Set(args.blocking ? verdict.blocking.map((b) => b.workspaceId) : []);
  for (const m of args.members) {
    const mine = verdict.findings.filter((f) => f.workspaceId === m.workspaceId);
    if (mine.length === 0) continue;
    await recordTrainReviewSiding(m, {
      trainLabel: args.trainLabel, findings: mine, blocking: args.blocking, sided: sidedIds.has(m.workspaceId), now,
    }, database).catch((err) => console.warn(`${tag}: could not comment on ${m.workspaceId} (non-fatal): ${errorMessage(err).slice(0, 200)}`));
  }
  const unattributed = verdict.findings.filter((f) => f.workspaceId === null);
  if (unattributed.length > 0) {
    console.warn(`${tag}: ${unattributed.length} finding(s) matched no member's files and stay on the train's evidence only`);
  }
  console.log(
    `${tag}: ${verdict.findings.length} finding(s), ${verdict.blocking.length} member(s) blocking` +
      (args.blocking ? `, siding ${sidedIds.size}` : ", advisory (sprint) — nobody sided"),
  );
  return {
    sided: args.blocking ? verdict.blocking : [],
    verdict,
    evidence: {
      status: "ran",
      findingCount: verdict.findings.length,
      blockingCount: verdict.blocking.length,
      sidedWorkspaceIds: [...sidedIds],
      blocking: args.blocking,
    },
  };
}
