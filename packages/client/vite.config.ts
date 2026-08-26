import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;
// Bind to "::" by default so the dev server answers on both IPv6 (::1) and
// IPv4 (127.0.0.1) localhost. Browsers resolve "localhost" to ::1 first on
// Windows, so an IPv4-only bind made http://localhost:5173 fail to connect.
// Node opens "::" as a dual-stack socket (ipv6Only=false), so IPv4 clients
// still reach it. Override with VITE_HOST=127.0.0.1 to restrict to IPv4.
const clientHost = process.env.VITE_HOST || "::";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // Pin the two heavy vendors into named, long-cached chunks so they are not
        // duplicated across the per-view lazy chunks. Both are only reachable from lazy
        // views/panels (xyflow/dagre via WorkflowsView; markdown via the detail/
        // workspace/butler panels), so they load on demand rather than on first paint.
        // (react/react-dom intentionally stay in the eager entry — splitting them out
        // produced only an empty chunk since the entry must load them anyway.)
        manualChunks: {
          "vendor-flow": ["@xyflow/react", "@dagrejs/dagre"],
          "vendor-markdown": ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  resolve: {
    // In dev (`serve`), prepend the "development" export condition so workspace
    // packages (@agentic-kanban/shared) resolve to their TypeScript SOURCE — the
    // shared `exports` map lists "development" → src first, so this wins over
    // "import" → dist. That removes the hidden first-start blocker where a clean
    // clone fails with `Failed to resolve entry for "@agentic-kanban/shared"`
    // because dist/ was never built (it's gitignored and nothing builds it on
    // install). For `vite build` we keep the compiled "import" → dist path and do
    // NOT add "development" — that condition would otherwise pull dev-only exports
    // of third-party deps into the production bundle.
    conditions:
      command === "serve"
        ? ["development", "default", "browser", "module", "import"]
        : ["default", "browser", "module", "import"],
  },
  server: {
    host: clientHost,
    port: clientPort,
    strictPort: true,
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/health": `http://127.0.0.1:${serverPort}`,
      "/ws": { target: `http://127.0.0.1:${serverPort}`, ws: true },
    },
  },
  test: {
    // Threads, not forks (2026-08-26): the default forks pool spawns a process per test
    // file (175 files), and on this Windows box worker-START timeouts under load failed
    // gate runs whose every test passed ("[vitest-pool]: Failed to start forks worker",
    // 3 distinct all-green runs killed on it — see #921's evidence trail). Client tests
    // are browser-domain and need no process isolation; worker_threads spawn no process,
    // so the timeout class disappears. The server package keeps forks (its fixtures need
    // real process isolation).
    pool: "threads",
    // #688: see packages/server/vitest.config.ts for rationale — no threshold yet,
    // this only makes coverage measurable and reportable.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      // #797: WITHOUT this, a run with ANY failing test writes no coverage report at all —
      // vitest's default is `reportOnFailure: false`. That is how #765 burned a 20m49s server
      // run for nothing (6 unrelated in-flight failures in a shared checkout) and why `shared`
      // had never been measured: its four tree-scanning guard suites go red whenever a
      // neighbour's uncommitted work is in the tree. Coverage is a MEASUREMENT, not a gate —
      // it must survive a red suite, and the number's provenance (how many suites failed) is
      // recorded in docs/line-coverage.md alongside it.
      reportOnFailure: true,
      exclude: ["**/dist/**", "**/node_modules/**", "**/*.test.ts", "**/*.test.tsx", "src/**/*.d.ts"],
    },
  },
}));
