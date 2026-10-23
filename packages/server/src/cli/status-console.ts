import {
  CONSOLE_COLUMNS, buildLabel, formatAge, formatElapsed,
  type ConsoleHost, type ConsoleModel, type ConsoleWorker,
} from "./status-console-model.js";
import {
  baseReleaseSection, connectSection, gatesSection, heading, isLive, issueRef, since, syncSection,
  type Glyphs, type Line, type Section, type Tone,
} from "./status-console-sections.js";
export * from "./status-console-model.js";

// Pure renderer for `status --watch` (#1421): draws a `ConsoleModel`, no clock and no I/O.

// ---------------------------------------------------------------- rendering

export interface ConsoleRenderOptions {
  cols: number;
  rows: number;
  color?: boolean;
  /** ASCII glyphs instead of Unicode bars/dots. */
  ascii?: boolean;
  intervalSec?: number;
  nowMs: number;
  /** IANA zone for the header clock; omitted = the machine's local zone. Tests pin it (#1553). */
  timeZone?: string;
  /** `a` — list every open issue instead of the pipeline summary. */
  allIssues?: boolean;
  /** Set when the last poll was slow and `--watch` is waiting longer between polls (#1614). */
  backoffNote?: string;
}


const RESET = "\x1b[0m";
const CODES: Record<Exclude<Tone, null>, string> = {
  red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m", cyan: "\x1b[36m", dim: "\x1b[2m", head: "\x1b[1m",
};

function trunc(text: string, width: number, ell: string): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").trimEnd();
  if (width <= 0) return "";
  if (flat.length <= width) return flat;
  return width === 1 ? ell : flat.slice(0, width - 1) + ell;
}



function headerSection(model: ConsoleModel, opts: ConsoleRenderOptions): Section {
  const hostBit = model.host
    ? `host ${model.host.freeGb != null ? `${model.host.freeGb.toFixed(1)}G` : "?"} free / floor ${model.host.floorGb}G`
    : "host n/a";
  const lines: Line[] = [{
    text: `agentic-kanban  ${model.project}${buildLabel(model)}  ${new Date(opts.nowMs).toLocaleTimeString("en-GB", opts.timeZone ? { timeZone: opts.timeZone } : undefined)}  ${hostBit}  ${model.openIssues} open · ${model.runningSessions} running  refresh ${opts.intervalSec ?? 5}s${opts.backoffNote ? ` (${opts.backoffNote})` : ""}`,
    tone: model.host?.hold ? "yellow" : "head",
  }];
  for (const e of model.errors) lines.push({ text: `! ${e}`, tone: "red" });
  return { id: "header", lines, keep: true };
}

function workerLine(w: ConsoleWorker, g: Glyphs): Line {
  const dots = g.dot.repeat(Math.min(w.load, 6)) || " ";
  const tickets = w.tickets.map((t) => `${issueRef(t.issueNumber)} ${t.status}${t.phase && t.phase !== t.status ? `/${t.phase}` : ""} ${since(t.startedAt, g.nowMs)}`).join(" · ");
  const verify = (w.verifyJobs ?? []).map((j) => ` · verify ${j}`).join("");
  const res = w.freeRamGb != null || w.freeDiskGb != null
    ? ` ram ${w.freeRamGb != null ? `${w.freeRamGb.toFixed(1)}G` : "?"} disk ${w.freeDiskGb != null ? `${Math.round(w.freeDiskGb)}G` : "?"} ·`
    : "";
  const hb = w.heartbeatAt ? `hb ${formatAge(g.nowMs - new Date(w.heartbeatAt).getTime())}` : "hb -";
  const ti = w.toolchainInstall;
  const install = ti && ti.state !== "done" ? ` · install ${ti.toolchains.join(",")} ${ti.state}${ti.state === "failed" && ti.reason ? ` (${ti.reason})` : ""}` : "";
  const profiles = w.profiles ? ` · ${w.profiles}` : "";
  const state = (w.status === "online" ? "" : ` [${w.status}]`) + (w.authExpired ? " [auth-expired]" : "") + install + profiles
    + (w.concurrencyMode ? ` · ${w.concurrencyMode}` : "") + (w.concurrencyHold ? ` · HOLD ${w.concurrencyHold}` : "")
    + (w.pinned && w.pinned.length > 0 ? ` · pinned ${w.pinned.join(",")}` : "") + (w.desiredPending ? " · settings pending" : "")
    + (w.updatePending ? ` · ${w.updatePending}` : "");
  return {
    text: ` ${w.name.padEnd(15)} ${dots.padEnd(3)} ${w.load}/${w.maxConcurrency}  ${(w.os ?? "").padEnd(5)} ${`${w.build ?? "-"}${w.buildStale ? "!" : ""}`.padEnd(7)}${res} ${tickets}${verify}${state}  ${hb}`,
    tone: w.status !== "online" || w.buildStale || w.concurrencyHold || w.authExpired || ti?.state === "failed" ? "yellow" : w.load > 0 ? "cyan" : null,
  };
}

function hostLine(h: ConsoleHost, g: Glyphs): Line {
  const slots = g.sq[0].repeat(Math.min(h.verifyActive, h.verifySlots)) + g.sq[1].repeat(Math.max(0, h.verifySlots - h.verifyActive));
  return {
    text: ` ${"host".padEnd(15)} verify ${slots} ${h.verifyActive}/${h.verifySlots}${h.verifyQueued ? ` · ${h.verifyQueued} queued` : ""}${h.hold ? ` · held: ${h.reason ?? "memory"}` : ""}`,
    tone: h.hold ? "yellow" : null,
  };
}

function workersSection(model: ConsoleModel, g: Glyphs, allIssues: boolean | undefined): Section | null {
  if (model.workers.length === 0 && !model.host) return null;
  const lines: Line[] = [heading("WORKERS")];
  if (model.workers.length === 0) lines.push({ text: " no workers registered", tone: "dim" });
  const stale = model.workers.filter((w) => w.stale);
  for (const w of model.workers) if (!w.stale || allIssues) lines.push(workerLine(w, g));
  if (stale.length > 0 && !allIssues) lines.push({ text: ` ${stale.length} stale worker${stale.length === 1 ? "" : "s"} (silent > 1d; a shows)`, tone: "dim" });
  if (model.host) lines.push(hostLine(model.host, g));
  return { id: "workers", lines, keep: true };
}

function trainSection(model: ConsoleModel, g: Glyphs): Section | null {
  if (model.trains.length === 0 && !model.window) return null;
  const parts = model.trains.filter((t) => !isLive(t)).slice(0, 3).map((t) => {
    const mark = t.state === "landed" ? (g.a ? "ok" : "✔") : t.state === "red" ? (g.a ? "X" : "✖") : "?";
    return `${t.label} ${mark} ${t.landed}/${t.members}${t.dropped ? ` (${t.dropped} dropped)` : ""}${t.gateRuns > 1 ? ` ${t.gateRuns} runs` : ""}`;
  });
  const w = model.window;
  if (w) parts.push(`window ${w.pending.map(issueRef).join(" ")} ${since(w.firstSeenAt, g.nowMs)}${w.maxWaitMs ? `/${formatElapsed(w.maxWaitMs)}` : ""}`);
  const bad = model.trains.some((t) => !isLive(t) && t.state === "red" && !t.superseded);
  const lines: Line[] = [heading("MERGE TRAIN"), { text: ` ${parts.join(" · ")}`, tone: bad ? "red" : null }];
  for (const t of model.trains.filter((x) => !isLive(x)).slice(0, 3)) {
    for (const d of (t.droppedDetail ?? []).slice(0, 3)) lines.push({ text: `   ${g.a ? "-" : "↳"} ${t.label} dropped ${d.ref}${d.deferred ? " (deferred)" : ""}: ${d.reason}`, tone: "dim" });
  }
  return { id: "train", lines };
}

function pipelineSection(model: ConsoleModel, allIssues: boolean | undefined): Section | null {
  if (model.issues.length === 0) return null;
  const lines: Line[] = [heading(`PIPELINE (${model.openIssues} open)`)];
  if (!allIssues) lines.push({ text: ` ${stageCounts(model)}`, tone: null });
  if (allIssues) {
    for (const i of model.issues) lines.push({ text: ` ${issueRef(i.issueNumber).padEnd(6)} ${i.statusName.padEnd(12)} ${i.title}`, tone: null });
    return { id: "pipeline", lines };
  }
  for (const c of CONSOLE_COLUMNS) {
    const ids = model.issues.filter((i) => i.column === c).map((i) => issueRef(i.issueNumber));
    if (ids.length === 0) continue;
    const shown = ids.length > 14 ? `${ids.slice(0, 14).join(" ")} +${ids.length - 14}` : ids.join(" ");
    lines.push({ text: ` ${c.padEnd(7)} ${shown}`, tone: c === "Todo" ? "dim" : null });
  }
  return { id: "pipeline", lines };
}

/** Counts per stage ("In Review 15 · Build 1"): the cheap PIPELINE that survives a short pane. */
function stageCounts(model: ConsoleModel): string {
  const parts: string[] = [];
  for (const c of CONSOLE_COLUMNS) {
    const counts = new Map<string, number>();
    for (const i of model.issues) if (i.column === c) counts.set(i.statusName, (counts.get(i.statusName) ?? 0) + 1);
    for (const [name, n] of counts) parts.push(`${name} ${n}`);
  }
  return parts.join(" · ");
}

function pipelineSummarySection(model: ConsoleModel): Section | null {
  if (model.issues.length === 0) return null;
  return { id: "pipeline", lines: [heading(`PIPELINE (${model.openIssues} open)`), { text: ` ${stageCounts(model)}`, tone: null }], keep: true };
}

/** Lines of the form "#N <reason>" that share level and reason collapse into "K <reason>: #a #b ...". */
function groupAttention(items: ConsoleModel["attention"]): ConsoleModel["attention"] {
  const groups = new Map<string, { level: "red" | "yellow"; rest: string; refs: string[] }>();
  const out: Array<ConsoleModel["attention"][number] | { group: string }> = [];
  for (const x of items) {
    const m = /^(#\d+) (.+)$/.exec(x.text);
    if (!m) { out.push(x); continue; }
    const key = `${x.level}|${m[2]}`;
    let grp = groups.get(key);
    if (!grp) { grp = { level: x.level, rest: m[2]!, refs: [] }; groups.set(key, grp); out.push({ group: key }); }
    grp.refs.push(m[1]!);
  }
  return out.map((o) => {
    if (!("group" in o)) return o;
    const grp = groups.get(o.group)!;
    return grp.refs.length === 1 ? { level: grp.level, text: `${grp.refs[0]} ${grp.rest}` } : { level: grp.level, text: `${grp.refs.length} ${grp.rest}: ${grp.refs.join(" ")}` };
  });
}

function attentionSection(model: ConsoleModel, g: Glyphs, rows: number): Section | null {
  if (model.attention.length === 0) return null;
  const lines: Line[] = [heading("ATTENTION")];
  const grouped = groupAttention(model.attention);
  const ordered = [...grouped.filter((x) => x.level === "red"), ...grouped.filter((x) => x.level !== "red")];
  const cap = Math.max(3, Math.floor(rows / 4));
  for (const x of ordered.slice(0, cap)) {
    const mark = x.level === "red" ? (g.a ? "X" : "✖") : (g.a ? "!" : "⚠");
    lines.push({ text: ` ${mark} ${x.text}`, tone: x.level });
  }
  if (ordered.length > cap) lines.push({ text: `   +${ordered.length - cap} more (a: all issues)`, tone: "dim" });
  return { id: "attention", lines, keep: true };
}

const paint = (text: string, tone: Tone, color: boolean | undefined): string =>
  color === false || !tone ? text : `${CODES[tone]}${text}${RESET}`;

/** Two columns at >= 140 cols: fleet state on the left, pipeline/attention/history on the right. */
function joinColumns(left: Line[], right: Line[], colW: number, g: Glyphs, color: boolean | undefined): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i], r = right[i];
    const lt = trunc(l?.text ?? "", colW, g.ell);
    const rt = trunc(r?.text ?? "", colW, g.ell);
    out.push({
      text: `${paint(lt, l?.tone ?? null, color)}${" ".repeat(colW - lt.length)} ${g.a ? "|" : "│"} ${paint(rt, r?.tone ?? null, color)}`,
      tone: null,
      raw: true,
    });
  }
  return out;
}

const LEFT_COLUMN = new Set(["workers", "gates", "base", "connect", "train"]);

function layoutSections(list: Section[], cols: number, g: Glyphs, color: boolean | undefined): Line[] {
  const wide = cols >= 140;
  const colW = wide ? Math.floor((cols - 3) / 2) : cols;
  const flat = (ss: Section[]): Line[] => ss.flatMap((s) => s.lines.map((l, idx) => {
    if (idx !== 0 || s.id === "header" || s.id === "merged") return l;
    const head = `${l.text} `;
    return { ...l, text: head + g.rule.repeat(Math.max(0, colW - head.length)) };
  }));
  const head = flat(list.filter((s) => s.id === "header"));
  const body = list.filter((s) => s.id !== "header");
  if (!wide) return [...head, ...flat(body)];
  return [...head, ...joinColumns(flat(body.filter((s) => LEFT_COLUMN.has(s.id))), flat(body.filter((s) => !LEFT_COLUMN.has(s.id))), colW, g, color)];
}

/** Still too tall after dropping history: cut the top, keeping ATTENTION whole when it can be located. */
function cutToFit(lines: Line[], rows: number, ell: string): Line[] {
  if (lines.length + 1 <= rows) return lines;
  const keepFrom = lines.findIndex((l) => l.text.startsWith("ATTENTION"));
  const cut: Line = { text: `${ell} cut to fit`, tone: "dim" };
  if (keepFrom < 0) return [...lines.slice(0, rows - 2), cut];
  const tail = lines.slice(keepFrom);
  return [...lines.slice(0, keepFrom).slice(0, Math.max(rows - 2 - tail.length, 1)), cut, ...tail];
}

export function renderConsole(model: ConsoleModel, opts: ConsoleRenderOptions): string[] {
  const cols = Math.max(opts.cols, 40);
  const rows = Math.max(opts.rows, 6);
  const a = opts.ascii === true;
  const g: Glyphs = { a, ell: a ? "~" : "…", dot: a ? "o" : "●", sq: a ? ["#", "-"] : ["■", "□"], rule: a ? "-" : "─", nowMs: opts.nowMs };

  const merged: Section = { id: "merged", lines: [{ text: `MERGED last 24 h: ${model.mergedToday}`, tone: model.mergedToday > 0 ? "green" : "dim" }] };
  let active = [
    headerSection(model, opts), workersSection(model, g, opts.allIssues), gatesSection(model, g), baseReleaseSection(model, g),
    connectSection(model, g), syncSection(model), trainSection(model, g),
    pipelineSection(model, opts.allIssues), attentionSection(model, g, rows), merged,
  ].filter((s): s is Section => s !== null);

  // Drop history first when the screen is short; WORKERS and ATTENTION are never dropped and
  // PIPELINE shrinks to its one-line stage summary rather than disappearing.
  for (const id of ["merged", "pipeline", "connect", "sync", "gates", "base", "train"]) {
    if (layoutSections(active, cols, g, opts.color).length + 1 <= rows) break;
    if (id === "pipeline") {
      const summary = pipelineSummarySection(model);
      active = active.flatMap((s) => (s.id === "pipeline" ? (summary ? [summary] : []) : [s]));
    } else active = active.filter((s) => s.id !== id);
  }
  const lines = cutToFit(layoutSections(active, cols, g, opts.color), rows, g.ell);
  lines.push({ text: `q quit · a ${opts.allIssues ? "summary" : "all issues"}`, tone: "dim" });

  return lines.map((l) => {
    if (l.raw) return l.text;
    return paint(trunc(a ? l.text.replace(/·/g, "|") : l.text, cols, g.ell), l.tone, opts.color);
  });
}

/** Cursor home, each line cleared to its end, then clear below — repaints in place, no flicker. */
export function consoleFrame(lines: string[]): string {
  return "\x1b[H" + lines.map((l) => `${l}\x1b[K`).join("\n") + "\n\x1b[J";
}
