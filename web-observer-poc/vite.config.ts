import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const host = process.env.SMARTST_WEB_OBSERVER_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.SMARTST_WEB_OBSERVER_PORT || "5175", 10);

export default defineConfig({
  root: rootDir,
  build: {
    chunkSizeWarningLimit: 600,
    emptyOutDir: true,
    outDir: resolve(rootDir, "../dist-web-observer-poc"),
  },
  server: {
    host,
    port,
  },
});
