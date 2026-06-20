// Pure computation backing the `session review-effectiveness` CLI command,
// extracted so the correctness-sensitive parts — trigger classification, the
// per-workspace session timeline (epoch-ms windows, closed so they don't overlap),
// and strict timezone-safe commit attribution — are unit-testable without a DB,
// git, or the network. The CLI handler keeps the I/O (DB query, `git log`,
// transcript parsing) and the report formatting.

export type ReviewSessionKind = "review" | "build" | "rework" | "noise" | "other";

/**
 * Map a session's triggerType to its lifecycle role. Unknown/empty types are
 * treated as build (implementer) work; monitor/navigator skills are noise and
 * dropped from the analysis entirely.
 */
export function classifyTriggerType(t: string | null): ReviewSessionKind {
  if (!t) return "build";
  if (t === "review" || t.startsWith("skill:code-review")) return "review";
  if (t.startsWith("skill:board-monitor") || t.startsWith("skill:board-navigator")) return "noise";
  if (t === "chat" || t === "fix-and-merge" || t === "fix-conflicts" || t === "plan-reject") return "rework";
  if (t === "verify" || t === "learning" || t === "bisect" || t === "reconcile") return "other";
  return "build";
}

/** A session row joined to its workspace + issue (the CLI's DB projection). */
export interface ReviewSessionRow {
  sessionId: string;
  triggerType: string | null;
  startedAt: string;
  endedAt: string | null;
  workspaceId: string;
  branch: string | null;
  wsStatus: string;
  provider: string | null;
  baseCommitSha: string | null;
  mergedHeadSha: string | null;
  mergedAt: string | null;
  issueNumber: number | null;
  issueTitle: string;
}

/**
 * A single session's attribution window. start/end are epoch-ms so they can be
 * compared against git author-dates safely — git's `%aI` carries a local tz
 * offset while session timestamps are UTC 'Z', so only numeric instant comparison
 * is correct (string comparison across the two is wrong).
 */
export interface ReviewSessionRange {
  id: string;
  kind: ReviewSessionKind;
  start: number;
  end: number;
}

export interface ReviewWorkspace {
  workspaceId: string;
  issueNumber: number;
  issueTitle: string;
  provider: string | null;
  wsStatus: string;
  merged: boolean;
  baseCommitSha: string | null;
  headRef: string | null;
  sessions: ReviewSessionRange[];
  hasReview: boolean;
}

/**
 * Group session rows into per-workspace timelines. Noise sessions are dropped;
 * each session gets an epoch-ms [start, end] window (open-ended windows close at
 * `nowMs`), and overlapping windows are trimmed against the next session's start
 * so a commit can attribute to at most one session.
 */
export function buildReviewWorkspaces(rows: ReviewSessionRow[], nowMs: number): Map<string, ReviewWorkspace> {
  const byWs = new Map<string, ReviewWorkspace>();
  for (const r of rows) {
    const kind = classifyTriggerType(r.triggerType);
    if (kind === "noise") continue;
    let ws = byWs.get(r.workspaceId);
    if (!ws) {
      ws = {
        workspaceId: r.workspaceId,
        issueNumber: r.issueNumber ?? 0,
        issueTitle: r.issueTitle,
        provider: r.provider,
        wsStatus: r.wsStatus,
        merged: !!r.mergedAt,
        baseCommitSha: r.baseCommitSha,
        headRef: r.mergedHeadSha ?? r.branch,
        sessions: [],
        hasReview: false,
      };
      byWs.set(r.workspaceId, ws);
    }
    if (kind === "review") ws.hasReview = true;
    ws.sessions.push({
      id: r.sessionId,
      kind,
      start: new Date(r.startedAt).getTime(),
      end: r.endedAt ? new Date(r.endedAt).getTime() : nowMs,
    });
  }

  // Close open-ended windows with the next session's start so they don't overlap.
  for (const ws of byWs.values()) {
    ws.sessions.sort((a, b) => a.start - b.start);
    for (let i = 0; i < ws.sessions.length - 1; i++) {
      const next = ws.sessions[i + 1].start;
      if (ws.sessions[i].end > next) ws.sessions[i].end = next;
    }
  }
  return byWs;
}

export interface ReviewCommit {
  date: string;
  message: string;
}

/** Per-workspace commit tallies bucketed by the role of the attributing session. */
export interface CommitAttribution {
  implementerCommits: number;
  reviewerCommits: number;
  /** Reviewer commit whose subject references THIS issue (#N / ak-N) — high confidence. */
  reviewerCommitsNamingIssue: number;
  reworkCommits: number;
  unattributedCommits: number;
  reviewerCommitSubjects: string[];
}

/**
 * Strictly attribute each commit to the session whose window contains its
 * author-time (with `graceMs` slack for a commit landing just after endedAt).
 * Commits authored outside every window — gaps between sessions, or commits
 * rebased in from master whose original author-time lies outside this workspace's
 * windows — are left unattributed on purpose. That is what keeps base..tip rebase
 * pollution out of the implementer/reviewer tallies.
 */
export function attributeCommits(ws: ReviewWorkspace, commits: ReviewCommit[], graceMs: number): CommitAttribution {
  const namesIssue = (msg: string): boolean => {
    const m = msg.toLowerCase();
    return m.includes(`#${ws.issueNumber}`) || m.includes(`ak-${ws.issueNumber}`) || m.includes(`(${ws.issueNumber})`);
  };
  const attribute = (commitDateIso: string): ReviewSessionRange | null => {
    const t = new Date(commitDateIso).getTime();
    if (!Number.isFinite(t)) return null;
    for (const s of ws.sessions) {
      if (t >= s.start && t <= s.end + graceMs) return s;
    }
    return null;
  };

  const out: CommitAttribution = {
    implementerCommits: 0,
    reviewerCommits: 0,
    reviewerCommitsNamingIssue: 0,
    reworkCommits: 0,
    unattributedCommits: 0,
    reviewerCommitSubjects: [],
  };
  for (const c of commits) {
    const kind = attribute(c.date)?.kind ?? null;
    if (kind === "review") {
      out.reviewerCommits++;
      if (namesIssue(c.message)) out.reviewerCommitsNamingIssue++;
      if (out.reviewerCommitSubjects.length < 5) out.reviewerCommitSubjects.push(c.message.slice(0, 60));
    } else if (kind === "rework") {
      out.reworkCommits++;
    } else if (kind === "build") {
      out.implementerCommits++;
    } else {
      out.unattributedCommits++;
    }
  }
  return out;
}

/** Full per-workspace result row: identity + git attribution (+ optional deep-transcript signals). */
export interface ReviewResult extends CommitAttribution {
  issue: number;
  title: string;
  provider: string | null;
  merged: boolean;
  wsStatus: string;
  gitResolved: boolean;
  reviewSessionIds: string[];
  reviewEdited?: boolean;
  reviewCommitted?: boolean;
  reviewMentionedMajorCritical?: boolean;
  reviewFixedMajorCritical?: boolean;
}

/** Build the per-workspace result from its commits (git attribution + identity). */
export function buildReviewResult(ws: ReviewWorkspace, commits: ReviewCommit[], graceMs: number): ReviewResult {
  return {
    issue: ws.issueNumber,
    title: ws.issueTitle.slice(0, 48),
    provider: ws.provider,
    merged: ws.merged,
    wsStatus: ws.wsStatus,
    gitResolved: commits.length > 0,
    ...attributeCommits(ws, commits, graceMs),
    reviewSessionIds: ws.sessions.filter((s) => s.kind === "review").map((s) => s.id),
  };
}

export interface ReviewSummaryOptions {
  reviewedWorkspacesInWindow: number;
  gitEligible: number;
  deep: boolean;
  window: { days: number; since: string; projectId: string; repoPath: string };
}

/** Aggregate roll-up exposed alongside the JSON report so the text formatter need not recompute it. */
export interface ReviewEffectivenessSummary {
  /** The machine-readable report object (the CLI's `--json` payload). */
  report: Record<string, unknown>;
  gitResolvedCount: number;
  reviewerCommittedCount: number;
  highConfReviewerCount: number;
  totalReviewerCommits: number;
  totalImplCommits: number;
  totalReworkCommits: number;
}

/** Round to one decimal percent; 0 when the denominator is 0. */
export function reviewPct(n: number, d: number): number {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

/**
 * Reduce per-workspace results into the full effectiveness report (git method,
 * plus the transcript/deep method and method-agreement block when `deep`). Pure —
 * the CLI handler does the I/O and renders the returned `report`.
 */
export function summarizeReviewEffectiveness(results: ReviewResult[], opts: ReviewSummaryOptions): ReviewEffectivenessSummary {
  const gitResolved = results.filter((r) => r.gitResolved);
  const reviewerCommittedWs = gitResolved.filter((r) => r.reviewerCommits > 0);
  const highConfReviewerWs = gitResolved.filter((r) => r.reviewerCommitsNamingIssue > 0);
  const totalReviewerCommits = results.reduce((s, r) => s + r.reviewerCommits, 0);
  const totalImplCommits = results.reduce((s, r) => s + r.implementerCommits, 0);
  const totalReworkCommits = results.reduce((s, r) => s + r.reworkCommits, 0);

  const report: Record<string, unknown> = {
    window: { days: opts.window.days, since: opts.window.since, projectId: opts.window.projectId, repoPath: opts.window.repoPath },
    scope: {
      reviewedWorkspacesInWindow: opts.reviewedWorkspacesInWindow,
      inspected: results.length,
      gitEligible: opts.gitEligible,
      gitHistoryResolved: gitResolved.length,
      primaryMethod: opts.deep ? "transcript (--deep)" : "git (run with --deep for the reliable transcript-based MAJOR/CRITICAL numbers)",
    },
    gitMethod: {
      caveat:
        "APPROXIMATE / lower bound. base..mergedHeadSha is polluted by the board's pre-merge rebases (stale baseCommitSha pulls in master commits), and mergedHeadSha is often null/unreachable. We strictly attribute a commit only when its author-time falls inside a review session's window, so this under-counts. Use --deep (transcript) as the source of truth.",
      workspacesWhereReviewerCommitted: reviewerCommittedWs.length,
      pctOfGitResolvedWhereReviewerCommitted: reviewPct(reviewerCommittedWs.length, gitResolved.length),
      highConfidenceReviewerFixes: highConfReviewerWs.length,
      pctOfGitResolvedHighConfidence: reviewPct(highConfReviewerWs.length, gitResolved.length),
      highConfidenceNote: "reviewer commit subject references its own issue (#N / ak-N) — filters out cross-branch attribution noise",
      totalReviewerCommits,
      totalImplementerCommits: totalImplCommits,
      totalReworkCommits,
      reviewerFixesThatMerged: reviewerCommittedWs.filter((r) => r.merged).length,
    },
  };

  if (opts.deep) {
    const reviewEdited = results.filter((r) => r.reviewEdited);
    const reviewMajorCrit = results.filter((r) => r.reviewMentionedMajorCritical);
    const fixedMajorCrit = results.filter((r) => r.reviewFixedMajorCritical);
    // agreement between the two methods
    const bothAgreeFix = results.filter((r) => r.reviewerCommits > 0 && (r.reviewEdited || r.reviewCommitted)).length;
    const gitOnly = results.filter((r) => r.reviewerCommits > 0 && !(r.reviewEdited || r.reviewCommitted)).length;
    const sessionOnly = results.filter((r) => r.reviewerCommits === 0 && (r.reviewEdited || r.reviewCommitted)).length;
    report.deepMethod = {
      note: "Severity is a heuristic transcript scan; treat as approximate.",
      reviewsThatEditedCode: reviewEdited.length,
      reviewsCitingMajorOrCritical: reviewMajorCrit.length,
      reviewsThatFixedAMajorOrCriticalFinding: fixedMajorCrit.length,
      pctOfReviewedThatFixedMajorCritical: reviewPct(fixedMajorCrit.length, results.length),
      fixedMajorCriticalIssues: fixedMajorCrit.map((r) => r.issue),
    };
    report.methodAgreement = { bothAgreeReviewerFixed: bothAgreeFix, gitOnly, sessionTranscriptOnly: sessionOnly };
  }

  report.perWorkspace = results.map((r) => ({
    issue: r.issue,
    title: r.title,
    provider: r.provider,
    implCommits: r.implementerCommits,
    reviewerCommits: r.reviewerCommits,
    reviewerCommitsNamingIssue: r.reviewerCommitsNamingIssue,
    reworkCommits: r.reworkCommits,
    merged: r.merged,
    ...(opts.deep
      ? { reviewEdited: r.reviewEdited, reviewFixedMajorCritical: r.reviewFixedMajorCritical }
      : {}),
    reviewerCommitSubjects: r.reviewerCommitSubjects,
  }));

  return {
    report,
    gitResolvedCount: gitResolved.length,
    reviewerCommittedCount: reviewerCommittedWs.length,
    highConfReviewerCount: highConfReviewerWs.length,
    totalReviewerCommits,
    totalImplCommits,
    totalReworkCommits,
  };
}

/**
 * Heuristic: does the review text cite at least one CRITICAL/MAJOR finding that is
 * NOT negated? Reviewers very commonly write "No CRITICAL or MAJOR issues", so a raw
 * keyword match over-counts. We accept an occurrence only when the ~16 chars before it
 * contain no negation cue ("no", "zero", "0", "without", "not", "n't").
 */
export function hasPositiveSeverity(text: string): boolean {
  if (!text) return false;
  const re = /\b(critical|major)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (!/\b(no|zero|without|not|n't)\b|0\s*$/.test(before)) return true;
  }
  return false;
}

/** The parsed-summary fields the deep (transcript) review pass inspects. */
export interface ReviewTranscriptSummary {
  agentSummary?: string;
  filesEdited?: string[];
  filesWritten?: string[];
  commandsRun?: string[];
}

export interface DeepReviewSignals {
  reviewEdited: boolean;
  reviewCommitted: boolean;
  reviewMentionedMajorCritical: boolean;
  reviewFixedMajorCritical: boolean;
}

/**
 * Derive the deep transcript-based signals for one workspace from the parsed
 * summaries of its review sessions: did a review edit code, run a git commit, cite
 * a non-negated MAJOR/CRITICAL finding, and — combined with the git evidence
 * (`reviewerCommits`) — actually fix one.
 */
export function computeDeepReviewSignals(summaries: ReviewTranscriptSummary[], reviewerCommits: number): DeepReviewSignals {
  let edited = false;
  let committed = false;
  let majorCritical = false;
  for (const s of summaries) {
    if ((s.filesEdited?.length ?? 0) > 0 || (s.filesWritten?.length ?? 0) > 0) edited = true;
    if ((s.commandsRun ?? []).some((c) => /git\s+commit/i.test(c))) committed = true;
    if (hasPositiveSeverity(s.agentSummary ?? "")) majorCritical = true;
  }
  return {
    reviewEdited: edited,
    reviewCommitted: committed,
    reviewMentionedMajorCritical: majorCritical,
    reviewFixedMajorCritical: majorCritical && (edited || committed || reviewerCommits > 0),
  };
}
