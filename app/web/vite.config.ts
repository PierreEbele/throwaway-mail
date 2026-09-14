import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const backend = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  build: { outDir: path.resolve(__dirname, "../../dist/web"), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: backend, changeOrigin: false },
      "/openapi.json": backend,
      "/docs": backend,
      "/healthz": backend,
    },
  },
});
