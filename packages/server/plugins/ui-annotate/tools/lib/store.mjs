// Annotation store + ticket export for the UI Annotate plugin. Zero dependencies.
//
// State lives under ~/.agentic-kanban/ui-annotate/<key>.json — NEVER in the repo (a dirty main
// checkout blocks the board's auto-merge). <key> is derived from UI_ANNOTATE_REPO (or
// UI_ANNOTATE_KEY), so the dashboard, `export.mjs` and `poll.mjs` all find the same file.
import os from 'node:os';
import crypto from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';

export function dataDir(env = process.env) {
  const dir = env.UI_ANNOTATE_DATA_DIR || join(os.homedir(), '.agentic-kanban', 'ui-annotate');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function storeKey(env = process.env) {
  const basis = env.UI_ANNOTATE_KEY || env.UI_ANNOTATE_REPO || 'default';
  return crypto.createHash('sha1').update(basis.toLowerCase()).digest('hex').slice(0, 12);
}

export const storePath = (env = process.env) => join(dataDir(env), `${storeKey(env)}.json`);
export const endpointPath = (env = process.env) => join(dataDir(env), `${storeKey(env)}.endpoint.json`);

const FIELD_MAX = { comment: 4000, text: 300, selector: 500, url: 1000, title: 300, tag: 40, session: 80 };
const clip = (v, k) => (typeof v === 'string' ? v.slice(0, FIELD_MAX[k]) : '');
const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0);

/** Normalise an untrusted annotation payload from the overlay. */
export function sanitizeInput(b) {
  const rect = b && typeof b.rect === 'object' && b.rect ? b.rect : {};
  const vp = b && typeof b.viewport === 'object' && b.viewport ? b.viewport : {};
  return {
    session: clip(b?.session, 'session') || 'default',
    url: clip(b?.url, 'url'),
    title: clip(b?.title, 'title'),
    selector: clip(b?.selector, 'selector'),
    tag: clip(b?.tag, 'tag'),
    text: clip(b?.text, 'text'),
    comment: clip(b?.comment, 'comment'),
    rect: { x: num(rect.x), y: num(rect.y), w: num(rect.w), h: num(rect.h) },
    viewport: { w: num(vp.w), h: num(vp.h) },
  };
}

/** In-memory store persisted atomically to one JSON file. `seq` bumps on every mutation. */
export function createStore(file, now = () => new Date().toISOString()) {
  let state = { seq: 0, nextId: 1, annotations: [] };
  try { if (existsSync(file)) state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* start empty */ }
  const waiters = new Set();

  const persist = () => {
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, file);
    } catch { /* best effort: in-memory state stays authoritative */ }
  };
  const bump = (a) => {
    state.seq += 1;
    a.seq = state.seq;
    a.updatedAt = now();
    persist();
    for (const w of [...waiters]) w();
  };

  return {
    get seq() { return state.seq; },
    list({ session, status, since } = {}) {
      return state.annotations.filter((a) =>
        (!session || a.session === session) && (!status || a.status === status) && (since == null || a.seq > since));
    },
    add(input) {
      const a = { id: state.nextId++, ...sanitizeInput(input), status: 'open', createdAt: now() };
      state.annotations.push(a);
      bump(a);
      return a;
    },
    update(id, patch) {
      const a = state.annotations.find((x) => x.id === id);
      if (!a) return null;
      if (typeof patch.comment === 'string') a.comment = clip(patch.comment, 'comment');
      if (patch.status === 'open' || patch.status === 'resolved') a.status = patch.status;
      if (typeof patch.reply === 'string') a.reply = clip(patch.reply, 'comment');
      bump(a);
      return a;
    },
    remove(id) {
      const i = state.annotations.findIndex((x) => x.id === id);
      if (i < 0) return false;
      state.annotations.splice(i, 1);
      state.seq += 1;
      persist();
      for (const w of [...waiters]) w();
      return true;
    },
    /** Resolves with the annotations changed after `since`, or [] after `timeoutMs`. */
    wait(since, timeoutMs, filter = {}) {
      return new Promise((res) => {
        const check = () => {
          if (state.seq <= since) return false;
          done(this.list({ ...filter, since }));
          return true;
        };
        const done = (v) => { clearTimeout(t); waiters.delete(onChange); res(v); };
        const onChange = () => { check(); };
        const t = setTimeout(() => done([]), timeoutMs);
        waiters.add(onChange);
        check();
      });
    },
  };
}

/** Structured, ticket-ready markdown: grouped by page, one numbered item per annotation. */
export function exportMarkdown(annotations, { title = 'UI feedback', includeResolved = false } = {}) {
  const items = annotations.filter((a) => includeResolved || a.status === 'open');
  if (!items.length) return `# ${title}\n\n_No open annotations._\n`;
  const byUrl = new Map();
  for (const a of items) {
    const k = a.url || '(unknown page)';
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k).push(a);
  }
  const out = [`# ${title}`, '', `${items.length} annotation${items.length === 1 ? '' : 's'} on ${byUrl.size} page${byUrl.size === 1 ? '' : 's'}.`, ''];
  for (const [url, list] of byUrl) {
    out.push(`## ${list[0].title ? `${list[0].title} — ` : ''}${url}`, '');
    for (const a of list) {
      out.push(`- [ ] **#${a.id}** ${a.comment.replace(/\r?\n/g, ' ') || '_(no comment)_'}`);
      out.push(`  - Element: \`${a.selector || a.tag}\`${a.text ? ` — "${a.text.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}`);
      if (a.rect && a.viewport?.w) out.push(`  - Position: ${a.rect.x},${a.rect.y} ${a.rect.w}×${a.rect.h} in a ${a.viewport.w}×${a.viewport.h} viewport`);
      if (a.status === 'resolved') out.push('  - Status: resolved');
    }
    out.push('');
  }
  return out.join('\n');
}
