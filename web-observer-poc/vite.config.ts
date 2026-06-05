import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  build: {
    chunkSizeWarningLimit: 600,
    emptyOutDir: true,
    outDir: resolve(rootDir, "../dist-web-observer-poc"),
  },
  server: {
    host: "127.0.0.1",
    port: 5175,
  },
});
