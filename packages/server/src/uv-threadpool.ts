/**
 * Widen the libuv threadpool before anything submits work to it.
 *
 * The default pool is 4 threads, shared by EVERY async fs op and the libsql
 * file driver — so during a workspace-summary rebuild (transcript tails, git
 * probe fs work) even a single-SELECT endpoint queues behind the pool and
 * measured seconds of latency (perf review 2026-08-11: /api/health 6-24s).
 * libuv reads UV_THREADPOOL_SIZE lazily at the first threadpool submission,
 * which is why this lives in its own module imported FIRST from the entry
 * points — a plain assignment later would be a silent no-op.
 *
 * An explicit user-set value always wins.
 */
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "12";
}

export {};
