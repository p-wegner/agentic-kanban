import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;
const clientHost = process.env.VITE_HOST || "127.0.0.1";

export default defineConfig({
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
    // Use the "default" export condition so workspace packages resolve to
    // their TypeScript source directly, without requiring a pre-build step.
    conditions: ["default", "browser", "module", "import"],
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
});
