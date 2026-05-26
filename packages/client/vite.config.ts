import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;
const clientHost = process.env.VITE_HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Use the "default" export condition so workspace packages resolve to
    // their TypeScript source directly, without requiring a pre-build step.
    conditions: ["default", "browser", "module", "import"],
  },
  server: {
    host: clientHost,
    port: clientPort,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/health": `http://localhost:${serverPort}`,
      "/ws": { target: `http://localhost:${serverPort}`, ws: true },
    },
  },
});
