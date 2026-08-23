#!/usr/bin/env node
/**
 * rework-loop-analysis.mjs — answers #804's three questions with the data the board
 * already has, so the "77% rework" number can be attributed instead of guessed at.
 *
 *   Q1  How often does a fix commit land in the same work unit as the commit it fixes?
 *   Q2  Does the merge gate run before or after the agent's own last verify?
 *   Q3  Is the follow-up's check stronger than the one the agent ran — i.e. could a
 *       re-timed gate have caught it at all?
 *
 * READ-ONLY. It opens the board DB with `readonly: true` and never writes to it.
 * Prefer pointing it at a COPY:
 *
 *   node scripts/rework-loop-analysis.mjs --db <path-to-a-copy-of-kanban.db>
 *   node scripts/rework-loop-analysis.mjs --db <copy> --json   # machine-readable
 *
 * Git is read with exactly two `git log` spawns over the whole history, not one spawn
 * per commit — per-file shelling out costs ~80ms of fork overhead each and has produced
 * confidently wrong numbers in this repo before.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const AS_JSON = args.includes('--json')
const DB_PATH = argOf('--db')
/** The dev board's own project id; override for another board. */
const PROJECT_ID = argOf('--project') ?? 'd1c5d9c1-4897-4e1b-acc3-2aa96de04117'

const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })

// ---------------------------------------------------------------- git: two spawns
// Pin the revision FIRST and read both logs from it. Several agents commit into this
// checkout concurrently, so re-resolving HEAD per call can hand the second walk a
// history the first one has never seen — which silently empties the branch grouping.
const headSha = argOf('--rev') ?? git('rev-parse', 'HEAD').trim()

const dag = new Map() // sha -> { at, parents, subj, files }
for (const line of git('log', headSha, '--format=C|%H|%at|%P|%s').split('\n')) {
  if (!line.startsWith('C|')) continue
  const [, sha, at, par, ...rest] = line.split('|')
  dag.set(sha, { at: Number(at), parents: par ? par.split(' ') : [], subj: rest.join('|'), files: [] })
}
{
  let cur = null
  for (const line of git('log', headSha, '--no-merges', '--numstat', '--format=C|%H').split('\n')) {
    if (line.startsWith('C|')) {
      cur = line.slice(2).trim()
      continue
    }
    if (!line.trim() || !cur) continue
    const p = line.split('\t')
    if (p.length !== 3) continue
    let f = p[2]
    if (f.includes(' => ')) f = f.replace(/\{.*? => (.*?)\}/, '$1').split(' => ').pop()
    dag.get(cur)?.files.push(f)
  }
}

// ------------------------------------------------- branch groups from the DAG shape
// A commit's "group" is the merge that brought it onto master, or itself if it landed
// directly on the first-parent chain. Two commits in the same branch group came from
// the same workspace branch — validated in docs/rework-loop-attribution.md against
// real workspace attribution (agrees on 32/33).
if (!dag.has(headSha)) throw new Error(`revision ${headSha} is not in the log that was just read`)
const firstParent = []
for (let cur = headSha; cur && dag.has(cur); cur = dag.get(cur).parents[0]) firstParent.push(cur)
const mainline = new Set(firstParent)
const group = new Map()
for (const s of firstParent) group.set(s, 'main:' + s)
for (const m of firstParent) {
  const par = dag.get(m).parents
  if (par.length < 2) continue
  const stack = par.slice(1)
  while (stack.length) {
    const s = stack.pop()
    if (!dag.has(s) || mainline.has(s) || group.has(s)) continue
    group.set(s, 'br:' + m)
    for (const p of dag.get(s).parents) if (!mainline.has(p) && !group.has(p)) stack.push(p)
  }
}

// Topological-ish position, so "the previous commit that touched this file" means the
// previous ANCESTOR, not merely the previous author timestamp (branches interleave).
const pos = new Map()
firstParent
  .slice()
  .reverse()
  .forEach((s, i) => pos.set(s, i * 1000))
for (const [sha, g] of group) if (!pos.has(sha)) pos.set(sha, (pos.get(g.slice(g.indexOf(':') + 1)) ?? 0) - 1)
const rank = (s) => [pos.get(s) ?? 0, dag.get(s)?.at ?? 0]
const before = (a, b) => {
  const ra = rank(a)
  const rb = rank(b)
  return ra[0] < rb[0] || (ra[0] === rb[0] && ra[1] < rb[1])
}

const IS_FIX = /^(fix|revert)\b/i
const TEST_FILE = /(__tests__|\.test\.|\.spec\.|\/e2e\/)/i
const isBranchCommit = (s) => (group.get(s) ?? '').startsWith('br:')

const perFile = new Map()
for (const [sha, c] of dag) {
  if (c.parents.length > 1) continue
  for (const f of c.files) {
    if (!perFile.has(f)) perFile.set(f, [])
    perFile.get(f).push(sha)
  }
}
for (const lst of perFile.values()) lst.sort((a, b) => (before(a, b) ? -1 : 1))

/** For each fix commit, the LATEST earlier commit touching one of the same files. */
const fixedBy = new Map()
const firstTouch = new Map()
for (const [f, lst] of perFile) {
  if (lst.length) firstTouch.set(f, lst[0])
  for (let i = 1; i < lst.length; i++) {
    const sha = lst[i]
    if (!IS_FIX.test(dag.get(sha).subj)) continue
    const prev = lst[i - 1]
    const cur = fixedBy.get(sha)
    if (!cur || before(cur, prev)) fixedBy.set(sha, prev)
  }
}

const pairs = [...fixedBy.keys()]
const samePreGate = pairs.filter((s) => group.get(s) === group.get(fixedBy.get(s)))
const escapedGate = pairs.filter((s) => group.get(s) !== group.get(fixedBy.get(s)) && isBranchCommit(fixedBy.get(s)))
const neverGated = pairs.filter((s) => group.get(s) !== group.get(fixedBy.get(s)) && !isBranchCommit(fixedBy.get(s)))

const pctl = (v, p) => {
  const a = [...v].sort((x, y) => x - y)
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN
}
const gapH = (s) => (dag.get(s).at - dag.get(fixedBy.get(s)).at) / 3600

function testShape(subset) {
  let brandNew = 0
  let existing = 0
  let none = 0
  for (const s of subset) {
    const tf = dag.get(s).files.filter((f) => TEST_FILE.test(f))
    if (!tf.length) none++
    else if (tf.some((f) => firstTouch.get(f) === s)) brandNew++
    else existing++
  }
  return { n: subset.length, brandNew, existing, none }
}

const result = {
  repo: REPO,
  head: headSha,
  commits: dag.size,
  q1: {
    fixCommitsWithAPredecessor: pairs.length,
    sameBranchGroup_fixedBeforeItsOwnGateRan: samePreGate.length,
    escapedARealMergeGate: escapedGate.length,
    predecessorNeverMetTheGate_directOnMaster: neverGated.length,
    gapHours: {
      median: pctl(pairs.map(gapH), 0.5),
      p25: pctl(pairs.map(gapH), 0.25),
      p75: pctl(pairs.map(gapH), 0.75),
      p90: pctl(pairs.map(gapH), 0.9),
    },
    sameGroupGapMedianHours: pctl(samePreGate.map(gapH), 0.5),
    crossGroupGapMedianHours: pctl([...escapedGate, ...neverGated].map(gapH), 0.5),
  },
  q3: { escapedARealMergeGate: testShape(escapedGate), fixedPreGate: testShape(samePreGate) },
}

// ------------------------------------------------------------------ DB (read-only)
if (DB_PATH) {
  // node:sqlite rather than the server's libsql, because `readOnly: true` is then a
  // property of the handle itself — this script must not be able to write the board DB.
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const ms = (s) => (s ? Date.parse(s) : null)

  const ws = db.prepare('select id, issue_id, merged_at from workspaces where merged_at is not null').all()
  const sessions = db.prepare('select workspace_id, id, started_at, ended_at from sessions').all()
  const byWs = new Map()
  for (const s of sessions) {
    if (!byWs.has(s.workspace_id)) byWs.set(s.workspace_id, [])
    byWs.get(s.workspace_id).push(s)
  }

  const gaps = []
  const counts = []
  let afterMerge = 0
  let multi = 0
  for (const w of ws) {
    const S = byWs.get(w.id) ?? []
    if (!S.length) continue
    counts.push(S.length)
    if (S.length > 1) multi++
    const ends = S.map((s) => ms(s.ended_at)).filter(Boolean)
    if (ends.length) gaps.push((ms(w.merged_at) - Math.max(...ends)) / 60000)
    if (S.some((s) => ms(s.started_at) > ms(w.merged_at))) afterMerge++
  }
  // The agent's own verify, where it was actually recorded.
  const tr = db.prepare('select session_id, max(recorded_at) last from test_runs group by session_id').all()
  const sesWs = new Map(sessions.map((s) => [s.id, s.workspace_id]))
  const wsById = new Map(ws.map((w) => [w.id, w]))
  const verifyGaps = []
  for (const t of tr) {
    const w = wsById.get(sesWs.get(t.session_id))
    if (w) verifyGaps.push((ms(w.merged_at) - ms(t.last)) / 60000)
  }
  const gateFailWs = db
    .prepare(
      "select count(distinct workspace_id) c from issue_comments where author='system' and body like '%gate failed%' and workspace_id in (select id from workspaces where merged_at is not null)",
    )
    .get().c

  result.q2 = {
    mergedWorkspacesWithSessions: gaps.length,
    sessionsPerWorkspace: { median: pctl(counts, 0.5), p90: pctl(counts, 0.9) },
    workspacesNeedingMoreThanOneSession: multi,
    mergeMinusLastSessionEndMinutes: {
      median: pctl(gaps, 0.5),
      p25: pctl(gaps, 0.25),
      p75: pctl(gaps, 0.75),
      p90: pctl(gaps, 0.9),
    },
    gateRanAfterTheAgentStopped: gaps.filter((g) => g >= 0).length,
    aSessionRanAfterTheMerge: afterMerge,
    sessionsWithRecordedTestRuns: tr.length,
    totalSessions: db.prepare('select count(*) c from sessions').get().c,
    mergeMinusLastRecordedVerifyMinutes: {
      n: verifyGaps.length,
      median: pctl(verifyGaps, 0.5),
      afterVerify: verifyGaps.filter((g) => g >= 0).length,
    },
    mergedWorkspacesThatFailedTheGateAtLeastOnce: gateFailWs,
    mergedWorkspaces: ws.length,
    workspaceMergeGateRows: db.prepare('select count(*) c from workspace_merge_gate').get().c,
  }

  // Gate exposure by ticket, independent of DAG shape (a fast-forwarded branch looks
  // like a direct-master commit in the DAG, so the two methods bound each other).
  const issueNo = new Map(
    db
      .prepare('select id, issue_number from issues where project_id = ? and issue_number is not null')
      .all(PROJECT_ID)
      .map((r) => [r.issue_number, r.id]),
  )
  const wsByIssue = new Map()
  for (const r of db.prepare('select issue_id, merged_at from workspaces').all()) {
    if (!wsByIssue.has(r.issue_id)) wsByIssue.set(r.issue_id, [])
    wsByIssue.get(r.issue_id).push(r)
  }
  const tally = { gated: 0, ungated: 0, unmergedWorkspace: 0, noTicket: 0 }
  for (const [, c] of dag) {
    if (c.parents.length !== 1) continue
    const m = /\(#(\d+)\)/.exec(c.subj)
    const iid = m && issueNo.get(Number(m[1]))
    if (!iid) {
      tally.noTicket++
      continue
    }
    const w = wsByIssue.get(iid)
    if (!w?.length) tally.ungated++
    else if (w.some((x) => x.merged_at)) tally.gated++
    else tally.unmergedWorkspace++
  }
  result.gateExposureByTicket = tally
  result.gateExposureByDagShape = {
    onAMergedBranch: [...dag].filter(([s, c]) => c.parents.length === 1 && isBranchCommit(s)).length,
    directOnMainline: [...dag].filter(([s, c]) => c.parents.length === 1 && !isBranchCommit(s)).length,
  }
  db.close()
}

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
}

const p = (n, d) => `${n} (${d ? ((100 * n) / d).toFixed(1) : '0.0'}%)`
console.log(`repo ${result.repo} @ ${result.head.slice(0, 10)} — ${result.commits} commits\n`)
console.log('Q1  does the fix land in the same work unit as the commit it fixes?')
console.log(`    fix/revert commits with an earlier commit on one of the same files: ${result.q1.fixCommitsWithAPredecessor}`)
console.log(`    same branch group — fixed before its own merge gate ever ran: ${p(result.q1.sameBranchGroup_fixedBeforeItsOwnGateRan, pairs.length)}`)
console.log(`    escaped a real merge gate:                                    ${p(result.q1.escapedARealMergeGate, pairs.length)}`)
console.log(`    the commit it fixes never met a gate (direct on master):      ${p(result.q1.predecessorNeverMetTheGate_directOnMaster, pairs.length)}`)
console.log(
  `    gap fix<-fixed, hours: median ${result.q1.gapHours.median.toFixed(2)}  p25 ${result.q1.gapHours.p25.toFixed(2)}  p75 ${result.q1.gapHours.p75.toFixed(2)}  p90 ${result.q1.gapHours.p90.toFixed(2)}`,
)
console.log(
  `      same-group median ${result.q1.sameGroupGapMedianHours.toFixed(2)} h vs cross-group ${result.q1.crossGroupGapMedianHours.toFixed(2)} h\n`,
)
if (result.q2) {
  const q = result.q2
  console.log("Q2  does the merge gate run before or after the agent's own last verify?")
  console.log(`    merged workspaces with sessions: ${q.mergedWorkspacesWithSessions}; sessions each: median ${q.sessionsPerWorkspace.median}, p90 ${q.sessionsPerWorkspace.p90}`)
  console.log(
    `    merged_at minus last session end, minutes: median ${q.mergeMinusLastSessionEndMinutes.median.toFixed(1)} (p25 ${q.mergeMinusLastSessionEndMinutes.p25.toFixed(1)}, p75 ${q.mergeMinusLastSessionEndMinutes.p75.toFixed(1)})`,
  )
  console.log(`    the gate ran AFTER the agent stopped: ${p(q.gateRanAfterTheAgentStopped, q.mergedWorkspacesWithSessions)}`)
  console.log(
    `    against a RECORDED agent test run (n=${q.mergeMinusLastRecordedVerifyMinutes.n}): after it in ${p(q.mergeMinusLastRecordedVerifyMinutes.afterVerify, q.mergeMinusLastRecordedVerifyMinutes.n)}, median +${q.mergeMinusLastRecordedVerifyMinutes.median.toFixed(1)} min`,
  )
  console.log(`    sessions that recorded ANY test run: ${p(q.sessionsWithRecordedTestRuns, q.totalSessions)} — this is the blind spot`)
  console.log(`    merged workspaces the gate withheld at least once: ${p(q.mergedWorkspacesThatFailedTheGateAtLeastOnce, q.mergedWorkspaces)}`)
  console.log(`    rows in workspace_merge_gate: ${q.workspaceMergeGateRows}\n`)
}
console.log('Q3  is the follow-up a stronger check than the one the agent ran?')
for (const [label, t] of [
  ['escaped a real gate', result.q3.escapedARealMergeGate],
  ['fixed pre-gate', result.q3.fixedPreGate],
]) {
  console.log(
    `    ${label.padEnd(20)} n=${String(t.n).padStart(4)}  brand-new test file ${p(t.brandNew, t.n)}  existing test edited ${p(t.existing, t.n)}  no test ${p(t.none, t.n)}`,
  )
}
if (result.gateExposureByTicket) {
  const t = result.gateExposureByTicket
  const d = result.gateExposureByDagShape
  console.log('\n    gate exposure of the whole history, two independent methods:')
  console.log(`      by ticket->workspace: gated ${t.gated}, ungated ${t.ungated}, workspace-never-merged ${t.unmergedWorkspace}, no resolvable ticket ${t.noTicket}`)
  console.log(`      by DAG shape:         on a merged branch ${d.onAMergedBranch}, direct on the first-parent chain ${d.directOnMainline}`)
}
