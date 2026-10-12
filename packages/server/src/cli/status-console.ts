import {
  CONSOLE_COLUMNS,
  type ConsoleHost, type ConsoleModel, type ConsoleTrain, type ConsoleWorker,
} from "./status-console-model.js";
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
  /** `a` — list every open issue instead of the pipeline summary. */
  allIssues?: boolean;
}

type Tone = "red" | "yellow" | "green" | "cyan" | "dim" | "head" | null;
/** `raw` lines are already truncated and painted (a joined two-column row). */
interface Line { text: string; tone: Tone; raw?: boolean }
interface Section { id: string; lines: Line[]; keep?: boolean }

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

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function since(iso: string | null, nowMs: number): string {
  return iso ? formatElapsed(nowMs - new Date(iso).getTime()) : "-";
}

const issueRef = (n: number | null) => (n != null ? `#${n}` : "#?");

interface Glyphs { a: boolean; ell: string; dot: string; sq: [string, string]; rule: string; nowMs: number }
const heading = (name: string): Line => ({ text: name, tone: "head" });

function headerSection(model: ConsoleModel, opts: ConsoleRenderOptions): Section {
  const hostBit = model.host
    ? `host ${model.host.freeGb != null ? `${model.host.freeGb.toFixed(1)}G` : "?"} free / floor ${model.host.floorGb}G`
    : "host n/a";
  const lines: Line[] = [{
    text: `agentic-kanban  ${model.project}${model.boardVersion ? ` (${model.boardVersion})` : ""}  ${new Date(opts.nowMs).toLocaleTimeString("en-GB")}  ${hostBit}  ${model.openIssues} open · ${model.runningSessions} running  refresh ${opts.intervalSec ?? 5}s`,
    tone: model.host?.hold ? "yellow" : "head",
  }];
  for (const e of model.errors) lines.push({ text: `! ${e}`, tone: "red" });
  return { id: "header", lines, keep: true };
}

function workerLine(w: ConsoleWorker, g: Glyphs): Line {
  const dots = g.dot.repeat(Math.min(w.load, 6)) || " ";
  const tickets = w.tickets.map((t) => `${issueRef(t.issueNumber)} ${t.status} ${since(t.startedAt, g.nowMs)}`).join(" · ");
  const hb = w.heartbeatAt ? `hb ${Math.max(0, Math.floor((g.nowMs - new Date(w.heartbeatAt).getTime()) / 1000))}s` : "hb -";
  const state = w.status === "online" ? "" : ` [${w.status}]`;
  return {
    text: ` ${w.name.padEnd(15)} ${dots.padEnd(3)} ${w.load}/${w.maxConcurrency}  ${(w.os ?? "").padEnd(5)} ${(w.build ?? "-").padEnd(7)} ${tickets}${state}  ${hb}`,
    tone: w.status !== "online" ? "yellow" : w.load > 0 ? "cyan" : null,
  };
}

function hostLine(h: ConsoleHost, g: Glyphs): Line {
  const slots = g.sq[0].repeat(Math.min(h.verifyActive, h.verifySlots)) + g.sq[1].repeat(Math.max(0, h.verifySlots - h.verifyActive));
  return {
    text: ` ${"host".padEnd(15)} verify ${slots} ${h.verifyActive}/${h.verifySlots}${h.verifyQueued ? ` · ${h.verifyQueued} queued` : ""}${h.hold ? ` · held: ${h.reason ?? "memory"}` : ""}`,
    tone: h.hold ? "yellow" : null,
  };
}

function workersSection(model: ConsoleModel, g: Glyphs): Section | null {
  if (model.workers.length === 0 && !model.host) return null;
  const lines: Line[] = [heading("WORKERS")];
  if (model.workers.length === 0) lines.push({ text: " no workers registered", tone: "dim" });
  for (const w of model.workers) lines.push(workerLine(w, g));
  if (model.host) lines.push(hostLine(model.host, g));
  return { id: "workers", lines, keep: true };
}

const isLive = (t: ConsoleTrain) => !t.finishedAt && ["assembling", "gating", "landing"].includes(t.state);

function gatesSection(model: ConsoleModel, g: Glyphs): Section | null {
  const live = model.trains.filter(isLive);
  const queued = model.host?.verifyQueued ?? 0;
  if (live.length === 0 && queued === 0) return null;
  const lines: Line[] = [heading("GATES & TESTS")];
  for (const t of live) {
    lines.push({ text: ` ${g.a ? ">" : "▶"} ${t.label.padEnd(12)} ${t.state.padEnd(10)} ${t.members} members · gate run ${t.gateRuns}  ${since(t.startedAt, g.nowMs)}`, tone: "cyan" });
  }
  if (queued > 0) lines.push({ text: ` ${g.a ? "|" : "⏸"} ${queued} verify chain(s) queued behind ${model.host?.verifyActive ?? 0} running`, tone: "yellow" });
  return { id: "gates", lines };
}

function trainSection(model: ConsoleModel, g: Glyphs): Section | null {
  if (model.trains.length === 0 && !model.window) return null;
  const parts = model.trains.filter((t) => !isLive(t)).slice(0, 3).map((t) => {
    const mark = t.state === "landed" ? (g.a ? "ok" : "✔") : t.state === "red" ? (g.a ? "X" : "✖") : "?";
    return `${t.label} ${mark} ${t.landed}/${t.members}${t.dropped ? ` (${t.dropped} dropped)` : ""}${t.gateRuns > 1 ? ` ${t.gateRuns} runs` : ""}`;
  });
  const w = model.window;
  if (w) parts.push(`window ${w.pending.map(issueRef).join(" ")} ${since(w.firstSeenAt, g.nowMs)}${w.maxWaitMs ? `/${formatElapsed(w.maxWaitMs)}` : ""}`);
  const bad = model.trains.some((t) => !isLive(t) && t.state === "red");
  return { id: "train", lines: [heading("MERGE TRAIN"), { text: ` ${parts.join(" · ")}`, tone: bad ? "red" : null }] };
}

function pipelineSection(model: ConsoleModel, allIssues: boolean | undefined): Section | null {
  if (model.issues.length === 0) return null;
  const lines: Line[] = [heading(`PIPELINE (${model.openIssues} open)`)];
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

function attentionSection(model: ConsoleModel, g: Glyphs): Section | null {
  if (model.attention.length === 0) return null;
  const lines: Line[] = [heading("ATTENTION")];
  for (const x of model.attention) {
    const mark = x.level === "red" ? (g.a ? "X" : "✖") : (g.a ? "!" : "⚠");
    lines.push({ text: ` ${mark} ${x.text}`, tone: x.level });
  }
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

const LEFT_COLUMN = new Set(["workers", "gates", "train"]);

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

  const merged: Section = { id: "merged", lines: [{ text: `MERGED TODAY ${model.mergedToday}`, tone: model.mergedToday > 0 ? "green" : "dim" }] };
  let active = [
    headerSection(model, opts), workersSection(model, g), gatesSection(model, g), trainSection(model, g),
    pipelineSection(model, opts.allIssues), attentionSection(model, g), merged,
  ].filter((s): s is Section => s !== null);

  // Drop history first when the screen is short; WORKERS and ATTENTION are never dropped.
  for (const id of ["merged", "pipeline", "train", "gates"]) {
    if (layoutSections(active, cols, g, opts.color).length + 1 <= rows) break;
    active = active.filter((s) => s.id !== id);
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
