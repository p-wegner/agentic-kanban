/**
 * Ticket-group scan (#661): consolidate an EXISTING backlog of too-granular tickets.
 *
 * One AI pass over a project's open Backlog/Todo tickets proposes GROUPS — sets of
 * tickets that share a code surface and are cheaper implemented together in one
 * workspace (one agent, one review, one merge-gate run). Applying a proposal writes
 * `coupled_with` edges (star topology from the lowest-numbered member — the coupled
 * COMPONENT is what matters, per `resolveCoupledComponent`), which is the same signal
 * the monitor's auto-group start (`resolveAutoStartGroupMembers`) and the destructive
 * `contract_coupled_issues` both consume. Nothing is merged, renamed, or cancelled —
 * every ticket keeps its identity; this is purely "declare what belongs together".
 *
 * Preview-first like backlog import: the default returns proposals without writing;
 * `apply: true` (or per-proposal confirmation from the caller) creates the edges.
 */
import { randomUUID } from "node:crypto";
import { extractModelJson } from "@agentic-kanban/shared/lib/model-json";
import type { TouchedFile } from "@agentic-kanban/shared";
import { isRegistrationFile, normalizeContentionPath } from "@agentic-kanban/shared/lib/file-contention";
import { MAX_TICKET_GROUP_SIZE } from "@agentic-kanban/shared/lib/ticket-group";
import type { Database } from "../db/index.js";
import { invokeClaudePrompt } from "./claude-cli.service.js";
import {
  getCoupledEdges,
  getOpenIssuesWithNode,
  getProjectDependencyEdges,
  getTerminalStatusIds,
  insertIssueDependencySafe,
} from "../repositories/issue-ai.repository.js";
import { getProjectIssuesTouchedFiles } from "../repositories/issue/touched-files.repository.js";
import { getStatusIdsByName } from "../repositories/project-status.repository.js";
import { listMergeTrainsForProject } from "../repositories/merge-train.repository.js";
import { getMergeQueueIssueRows, getMergeQueueWorkspaceRows } from "../repositories/merge-queue.repository.js";
import { TERMINAL_STATUS_NAMES } from "@agentic-kanban/shared/lib/status-view";
import type { MergeTrainGateEvidenceDto } from "@agentic-kanban/shared/types";

export interface TicketGroupProposal {
  /** Issue numbers, lowest first (the monitor would pick the lowest as group lead). */
  issueNumbers: number[];
  issueIds: string[];
  titles: string[];
  rationale: string;
  /** Pairs inside the proposal that ALREADY carry a coupled_with edge (informational). */
  alreadyCoupledPairs: number;
}

export interface TicketGroupScanResult {
  proposals: TicketGroupProposal[];
  /** Proposals the scan dropped, with the reason — surfaced so a preview is honest. */
  rejected: Array<{ issueNumbers: number[]; reason: string }>;
  scannedCount: number;
  /** Only set when apply=true: number of coupled_with edges actually created. */
  createdEdges?: number;
}

const MAX_PROPOSAL_SIZE = 8;
const DESCRIPTION_SNIPPET_LENGTH = 600;

/**
 * Timeout budget for the one model call (#665). Base + per-candidate, capped: a 17-ticket
 * backlog gets ~2.5 min and a 100-ticket one the 10-minute ceiling, instead of every size
 * sharing `invokeClaudePrompt`'s 60s default and the big ones always failing.
 */
const GROUP_SCAN_BASE_TIMEOUT_MS = 90_000;
const GROUP_SCAN_MS_PER_TICKET = 4_000;
const GROUP_SCAN_TIMEOUT_CAP_MS = 600_000;

export async function scanForTicketGroups(
  projectId: string,
  database: Database,
  opts: { apply?: boolean } = {},
): Promise<TicketGroupScanResult> {
  const candidateStatusIds = new Set(await getStatusIdsByName(projectId, ["Backlog", "Todo"], database));
  if (candidateStatusIds.size === 0) {
    return { proposals: [], rejected: [], scannedCount: 0 };
  }
  const all = await getOpenIssuesWithNode(projectId, database);
  const candidates = all.filter((i) => i.statusId != null && candidateStatusIds.has(i.statusId) && i.issueNumber != null);
  if (candidates.length < 2) {
    return { proposals: [], rejected: [], scannedCount: candidates.length };
  }

  const byNumber = new Map(candidates.map((i) => [i.issueNumber as number, i]));
  const edges = await getProjectDependencyEdges(projectId, database);
  const coupled = await getCoupledEdges(projectId, database);
  const coupledPairs = new Set(coupled.map((e) => pairKey(e.issueId, e.dependsOnId)));
  // A pre-existing sequential edge means the pair is ORDERED — grouping it into one
  // parallel workspace contradicts the declared ordering (same guard as the analyzer's
  // coupling rule, #916).
  const sequentialPairs = new Set(
    edges.filter((e) => e.type === "depends_on" || e.type === "blocked_by").map((e) => pairKey(e.from, e.to)),
  );

  const listing = candidates
    .map((i) => {
      const desc = (i.description ?? "").replace(/\s+/g, " ").slice(0, DESCRIPTION_SNIPPET_LENGTH);
      return `#${i.issueNumber}: ${i.title}\n  ${desc || "(no description)"}`;
    })
    .join("\n");

  const prompt = `You are consolidating a kanban backlog whose tickets are too granular: adjacent tickets that touch the same code cost one full agent worktree + review + merge-gate run EACH, when a group of them could share one.

Below are the open backlog tickets of one project. Propose GROUPS of 2-${MAX_PROPOSAL_SIZE} tickets that should be implemented together in ONE workspace because they touch the same files/subsystem, follow the same mechanical pattern, or one's change surface subsumes another's.

Rules:
- Group by shared CODE SURFACE or shared mechanical pattern, never by mere topical similarity.
- Never put two tickets in one group when one clearly must land before the other can start (that is a sequential dependency, not a group).
- Prefer several small confident groups over one sprawling one. A ticket appears in at most one group.
- Do not force it: leave tickets ungrouped when unsure.

Tickets:
${listing}

Respond with JSON only:
{"groups": [{"issueNumbers": [12, 14, 15], "rationale": "one sentence naming the shared surface"}]}`;

  // #665 — the 60s default is far too short for THIS operation. The prompt embeds every open
  // backlog ticket with a description snippet, and the feature exists for backlogs that are
  // "too granular", i.e. long ones — 17 tickets already timed the call out on this board.
  // Nobody watches a spinner for a batch consolidation, so scale the budget with the input
  // rather than making the operator retry into the same wall.
  const timeout = Math.min(GROUP_SCAN_TIMEOUT_CAP_MS, GROUP_SCAN_BASE_TIMEOUT_MS + candidates.length * GROUP_SCAN_MS_PER_TICKET);
  const stdout = await invokeClaudePrompt(prompt, { database, timeout });
  const parsed = extractModelJson(stdout, { shape: "object" }) as {
    groups?: Array<{ issueNumbers?: unknown; rationale?: unknown }>;
  };

  const proposals: TicketGroupProposal[] = [];
  const rejected: Array<{ issueNumbers: number[]; reason: string }> = [];
  const claimed = new Set<number>();
  for (const raw of parsed.groups ?? []) {
    const numbers = Array.isArray(raw.issueNumbers)
      ? [...new Set(raw.issueNumbers.filter((n): n is number => typeof n === "number"))].sort((a, b) => a - b)
      : [];
    const rationale = typeof raw.rationale === "string" ? raw.rationale : "";
    if (numbers.length < 2) {
      if (numbers.length > 0) rejected.push({ issueNumbers: numbers, reason: "fewer than 2 valid members" });
      continue;
    }
    if (numbers.length > MAX_PROPOSAL_SIZE) {
      rejected.push({ issueNumbers: numbers, reason: `larger than the ${MAX_PROPOSAL_SIZE}-ticket cap` });
      continue;
    }
    const unknown = numbers.filter((n) => !byNumber.has(n));
    if (unknown.length > 0) {
      rejected.push({ issueNumbers: numbers, reason: `not open backlog tickets: #${unknown.join(", #")}` });
      continue;
    }
    const overlapping = numbers.filter((n) => claimed.has(n));
    if (overlapping.length > 0) {
      rejected.push({ issueNumbers: numbers, reason: `already claimed by an earlier group: #${overlapping.join(", #")}` });
      continue;
    }
    const members = numbers.map((n) => byNumber.get(n)!);
    const sequentialInside = pairsOf(members.map((m) => m.id)).filter((p) => sequentialPairs.has(p));
    if (sequentialInside.length > 0) {
      rejected.push({ issueNumbers: numbers, reason: "members carry a sequential (depends_on/blocked_by) edge between them" });
      continue;
    }
    numbers.forEach((n) => claimed.add(n));
    proposals.push({
      issueNumbers: numbers,
      issueIds: members.map((m) => m.id),
      titles: members.map((m) => m.title),
      rationale,
      alreadyCoupledPairs: pairsOf(members.map((m) => m.id)).filter((p) => coupledPairs.has(p)).length,
    });
  }

  const result: TicketGroupScanResult = { proposals, rejected, scannedCount: candidates.length };

  if (opts.apply && proposals.length > 0) {
    result.createdEdges = await applyTicketGroupProposals(proposals, coupledPairs, database);
  }
  return result;
}

/**
 * Write the coupled_with edges for accepted proposals: a star from the lowest-numbered
 * member. `coupled_with` is symmetric and the consumers resolve the CONNECTED COMPONENT,
 * so a star declares the same group as a full clique at N-1 edges instead of N*(N-1)/2.
 */
export async function applyTicketGroupProposals(
  proposals: TicketGroupProposal[],
  existingCoupledPairs: Set<string>,
  database: Database,
): Promise<number> {
  const now = new Date().toISOString();
  let created = 0;
  for (const proposal of proposals) {
    const [anchor, ...rest] = proposal.issueIds;
    for (const other of rest) {
      if (existingCoupledPairs.has(pairKey(anchor, other))) continue;
      await insertIssueDependencySafe(
        { id: randomUUID(), issueId: anchor, dependsOnId: other, type: "coupled_with", createdAt: now },
        database,
      );
      existingCoupledPairs.add(pairKey(anchor, other));
      created++;
    }
  }
  return created;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function pairsOf(ids: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push(pairKey(ids[i], ids[j]));
  }
  return out;
}

/**
 * #918: seed `coupled_with` from `issues.touchedFilesJson` — a DETERMINISTIC grouping
 * signal (no LLM call) so a cold backlog (freshly decomposed/imported/enhanced, zero
 * `coupled_with` edges yet) still forms ticket groups. `scanForTicketGroups` above needs
 * an AI pass and is the tool for consolidating an established backlog; this is the seed
 * that gives auto_group_coupled something to work with the moment tickets exist.
 *
 * Two tickets are proposed as coupled when they share at least `minSharedFiles` predicted
 * files — EXCLUDING hot/registration files (`isRegistrationFile`, #119's contention
 * vocabulary): a shared `app.ts`/`routes.ts` means CONTENTION (two tickets will conflict
 * editing the same wiring file), not COUPLING (these tickets belong in one workspace). A
 * shared narrow, non-hot file (a specific model/component/service) is the actual signal.
 *
 * Sequential (`depends_on`/`blocked_by`) pairs are excluded — same rule as
 * `scanForTicketGroups` and the monitor's own auto-group start: grouping declares "start
 * together", which contradicts a declared ordering.
 *
 * Connected components are computed over the qualifying pairs and capped at
 * `MAX_TICKET_GROUP_SIZE` — an oversized component is split into that many
 * lowest-numbered-first chunks rather than dropped, so a hot subsystem still yields
 * usable (smaller) groups instead of nothing.
 */
export async function scanTouchedFilesForTicketGroups(
  projectId: string,
  database: Database,
  opts: { apply?: boolean; minSharedFiles?: number } = {},
): Promise<TicketGroupScanResult> {
  const minSharedFiles = Math.max(1, opts.minSharedFiles ?? 2);
  const candidateStatusIds = new Set(await getStatusIdsByName(projectId, ["Backlog", "Todo"], database));
  if (candidateStatusIds.size === 0) {
    return { proposals: [], rejected: [], scannedCount: 0 };
  }
  const all = await getProjectIssuesTouchedFiles(projectId, database);
  const candidates = all.filter((i) => i.statusId != null && candidateStatusIds.has(i.statusId) && i.issueNumber != null);
  if (candidates.length < 2) {
    return { proposals: [], rejected: [], scannedCount: candidates.length };
  }

  const byId = new Map(candidates.map((i) => [i.id, i]));
  const filesByIssue = new Map<string, Set<string>>();
  for (const issue of candidates) {
    if (!issue.touchedFilesJson) continue;
    let parsed: TouchedFile[];
    try { parsed = JSON.parse(issue.touchedFilesJson) as TouchedFile[]; } catch { continue; }
    const paths = new Set(
      parsed
        .map((f) => normalizeContentionPath(f.path))
        .filter((p) => p && !isRegistrationFile(p)),
    );
    if (paths.size > 0) filesByIssue.set(issue.id, paths);
  }
  if (filesByIssue.size < 2) {
    return { proposals: [], rejected: [], scannedCount: candidates.length };
  }

  const edges = await getProjectDependencyEdges(projectId, database);
  const coupled = await getCoupledEdges(projectId, database);
  const coupledPairs = new Set(coupled.map((e) => pairKey(e.issueId, e.dependsOnId)));
  const sequentialPairs = new Set(
    edges.filter((e) => e.type === "depends_on" || e.type === "blocked_by").map((e) => pairKey(e.from, e.to)),
  );

  const qualifyingIds = [...filesByIssue.keys()];
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = adjacency.get(a);
    if (!s) { s = new Set(); adjacency.set(a, s); }
    s.add(b);
  };
  for (let i = 0; i < qualifyingIds.length; i++) {
    for (let j = i + 1; j < qualifyingIds.length; j++) {
      const a = qualifyingIds[i];
      const b = qualifyingIds[j];
      if (sequentialPairs.has(pairKey(a, b))) continue;
      const shared = [...filesByIssue.get(a)!].filter((f) => filesByIssue.get(b)!.has(f));
      if (shared.length >= minSharedFiles) link(a, b);
    }
  }

  const { proposals, rejected } = componentsToProposals(
    connectedComponents(qualifyingIds, adjacency),
    (id) => byId.get(id)!,
    () => `Share >= ${minSharedFiles} predicted file(s) outside registration/hot files`,
    coupledPairs,
  );

  const result: TicketGroupScanResult = { proposals, rejected, scannedCount: candidates.length };
  if (opts.apply && proposals.length > 0) {
    result.createdEdges = await applyTicketGroupProposals(proposals, coupledPairs, database);
  }
  return result;
}

/** Connected components over an undirected adjacency, in first-seen order; singletons omitted. */
function connectedComponents(ids: string[], adjacency: Map<string, Set<string>>): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of ids) {
    if (visited.has(id) || !adjacency.has(id)) continue;
    const component: string[] = [];
    const stack = [id];
    visited.add(id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      component.push(cur);
      for (const next of adjacency.get(cur) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    if (component.length >= 2) components.push(component);
  }
  return components;
}

/**
 * Turn issue-id components into proposals: lowest-numbered first, split into
 * `MAX_TICKET_GROUP_SIZE` chunks rather than dropped (a hot subsystem still yields usable,
 * smaller groups), with the oversize component reported under `rejected` so a preview is
 * honest about the split. Shared by every deterministic scan mode.
 */
function componentsToProposals(
  components: string[][],
  issueOf: (id: string) => { id: string; issueNumber: number | null; title: string },
  rationaleFor: (chunkIds: string[]) => string,
  coupledPairs: Set<string>,
): { proposals: TicketGroupProposal[]; rejected: Array<{ issueNumbers: number[]; reason: string }> } {
  const proposals: TicketGroupProposal[] = [];
  const rejected: Array<{ issueNumbers: number[]; reason: string }> = [];
  for (const component of components) {
    const sortedIds = component
      .map(issueOf)
      .sort((a, b) => (a.issueNumber as number) - (b.issueNumber as number))
      .map((i) => i.id);
    for (let start = 0; start < sortedIds.length; start += MAX_TICKET_GROUP_SIZE) {
      const chunkIds = sortedIds.slice(start, start + MAX_TICKET_GROUP_SIZE);
      if (chunkIds.length < 2) continue;
      const members = chunkIds.map(issueOf);
      proposals.push({
        issueNumbers: members.map((m) => m.issueNumber as number),
        issueIds: chunkIds,
        titles: members.map((m) => m.title),
        rationale: rationaleFor(chunkIds),
        alreadyCoupledPairs: pairsOf(chunkIds).filter((p) => coupledPairs.has(p)).length,
      });
    }
    if (sortedIds.length > MAX_TICKET_GROUP_SIZE) {
      rejected.push({
        issueNumbers: sortedIds.map((id) => issueOf(id).issueNumber as number),
        reason: `component larger than the ${MAX_TICKET_GROUP_SIZE}-ticket cap; split into smaller groups`,
      });
    }
  }
  return { proposals, rejected };
}

/** How many of a project's most recent trains the `train-conflicts` scan reads back. */
const TRAIN_CONFLICT_SCAN_TRAINS = 20;

/**
 * #1191: propose `coupled_with` groups from the member-vs-member conflict clusters a merge
 * train recorded while assembling (`MergeTrainGateEvidenceDto.conflictClusters`). Two
 * branches that cannot be merged with EACH OTHER — not merely with the base — are editing the
 * same code, which is the definition of a coupled pair (decision 015); the train's read-only
 * `merge-tree` already proved it, so this scan makes no model call and reads no source.
 *
 * Deterministic, like `scanTouchedFilesForTicketGroups`, and with the same guards: sequential
 * (`depends_on`/`blocked_by`) pairs never group, components are chunked at
 * `MAX_TICKET_GROUP_SIZE`. Unlike it, the candidates are whatever the trains carried — tickets
 * in flight, not Backlog/Todo — minus anything already in a terminal status: a cluster whose
 * other members have landed has nothing left to couple. Clusters from a project's last
 * {@link TRAIN_CONFLICT_SCAN_TRAINS} trains are unioned, so a pair that collides on every
 * train shows up once, not once per train.
 *
 * Preview by default; `apply: true` writes the edges. Never called by the train itself —
 * coupling two tickets is an operator's call, the train only records the evidence.
 */
export async function scanMergeTrainConflictsForTicketGroups(
  projectId: string,
  database: Database,
  opts: { apply?: boolean } = {},
): Promise<TicketGroupScanResult> {
  const trains = (await listMergeTrainsForProject(projectId, database)).slice(0, TRAIN_CONFLICT_SCAN_TRAINS);
  const clusters: Array<{ label: string; workspaceIds: string[] }> = [];
  for (const train of trains) {
    if (!train.gateEvidence) continue;
    let evidence: MergeTrainGateEvidenceDto;
    try { evidence = JSON.parse(train.gateEvidence) as MergeTrainGateEvidenceDto; } catch { continue; }
    for (const c of evidence.conflictClusters ?? []) {
      if (Array.isArray(c?.workspaceIds) && c.workspaceIds.length >= 2) clusters.push({ label: train.label, workspaceIds: c.workspaceIds });
    }
  }
  if (clusters.length === 0) return { proposals: [], rejected: [], scannedCount: 0 };

  const workspaceIds = [...new Set(clusters.flatMap((c) => c.workspaceIds))];
  const workspaceRows = await getMergeQueueWorkspaceRows(workspaceIds, database);
  const issueIdOfWorkspace = new Map(workspaceRows.map((w) => [w.id, w.issueId]));
  const issueRows = await getMergeQueueIssueRows([...new Set(workspaceRows.map((w) => w.issueId))], database);
  const terminalStatusIds = new Set(await getStatusIdsByName(projectId, [...TERMINAL_STATUS_NAMES], database));
  const byId = new Map(
    issueRows
      .filter((i) => i.projectId === projectId && i.issueNumber != null && !(i.statusId && terminalStatusIds.has(i.statusId)))
      .map((i) => [i.id, i]),
  );

  const edges = await getProjectDependencyEdges(projectId, database);
  const coupled = await getCoupledEdges(projectId, database);
  const coupledPairs = new Set(coupled.map((e) => pairKey(e.issueId, e.dependsOnId)));
  const sequentialPairs = new Set(
    edges.filter((e) => e.type === "depends_on" || e.type === "blocked_by").map((e) => pairKey(e.from, e.to)),
  );

  // Union every cluster's pairs into one issue-level graph. A cluster names workspaces; two
  // workspaces of ONE issue (a retry) collapse to a self-pair and are skipped.
  const adjacency = new Map<string, Set<string>>();
  const trainsOfPair = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = adjacency.get(a);
    if (!s) { s = new Set(); adjacency.set(a, s); }
    s.add(b);
  };
  const rejected: Array<{ issueNumbers: number[]; reason: string }> = [];
  for (const cluster of clusters) {
    const issueIds = [...new Set(cluster.workspaceIds.map((w) => issueIdOfWorkspace.get(w)).filter((id): id is string => !!id))];
    const live = issueIds.filter((id) => byId.has(id));
    if (live.length < 2) {
      const numbers = issueIds.map((id) => issueRows.find((i) => i.id === id)?.issueNumber).filter((n): n is number => n != null);
      if (numbers.length >= 2) rejected.push({ issueNumbers: numbers.sort((a, b) => a - b), reason: `train ${cluster.label}: all but one member already landed or closed` });
      continue;
    }
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const key = pairKey(live[i], live[j]);
        if (sequentialPairs.has(key)) continue;
        link(live[i], live[j]);
        link(live[j], live[i]);
        let t = trainsOfPair.get(key);
        if (!t) { t = new Set(); trainsOfPair.set(key, t); }
        t.add(cluster.label);
      }
    }
  }

  const issueOf = (id: string) => byId.get(id)!;
  const built = componentsToProposals(
    connectedComponents([...adjacency.keys()], adjacency),
    issueOf,
    (chunkIds) => {
      const labels = new Set(pairsOf(chunkIds).flatMap((p) => [...(trainsOfPair.get(p) ?? [])]));
      return `Branches conflicted with each other on merge train${labels.size === 1 ? "" : "s"} ${[...labels].join(", ")} — same code, coupled tickets in disguise`;
    },
    coupledPairs,
  );
  const result: TicketGroupScanResult = {
    proposals: built.proposals,
    rejected: [...rejected, ...built.rejected],
    scannedCount: byId.size,
  };
  if (opts.apply && built.proposals.length > 0) {
    result.createdEdges = await applyTicketGroupProposals(built.proposals, coupledPairs, database);
  }
  return result;
}
