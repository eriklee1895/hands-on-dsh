import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4317" },
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  test: {
    server: {
      deps: { inline: [/@copilotkit\/react-core/u] },
    },
  },
});
