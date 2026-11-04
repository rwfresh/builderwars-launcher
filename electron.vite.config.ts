import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const root = import.meta.dirname;

/** Production CSP for the shell renderer. Dev skips it: Vite's dev server needs inline scripts and a websocket. */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";
function cspMeta(): Plugin {
  return {
    name: "builderwars-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CSP }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: resolve(root, "out/main"),
      rolldownOptions: { input: { index: resolve(root, "electron/main/index.ts") } },
    },
  },
  preload: {
    build: {
      outDir: resolve(root, "out/preload"),
      // Sandboxed preloads must be single-file CommonJS that only require("electron").
      isolatedEntries: true,
      externalizeDeps: false,
      rolldownOptions: {
        input: {
          shell: resolve(root, "electron/preload/shell.ts"),
          game: resolve(root, "electron/preload/game.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root,
    plugins: [react(), cspMeta()],
    build: {
      outDir: resolve(root, "out/renderer"),
      target: "es2022",
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rolldownOptions: { input: resolve(root, "index.html") },
    },
  },
});
