import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const serverPort = Number(process.env.SERVER_PORT) || 3001;
const clientPort = Number(process.env.VITE_PORT) || 5173;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: clientPort,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/health": `http://localhost:${serverPort}`,
      "/ws": { target: `http://localhost:${serverPort}`, ws: true },
    },
  },
});
