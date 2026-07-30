import { defineConfig } from "vite";

// Tauri expects a fixed port and needs to know the host when developing on a device.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // `index.html` lives in src/ alongside the code it loads (Plan.md §8), so
  // that is Vite's root; the bundle still lands in dist/ at the repo root,
  // which is what tauri.conf.json's `frontendDist` points at.
  root: "src",
  // Tauri serves the frontend from a file:// style origin in production, so all
  // asset URLs must be relative.
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust sources are compiled by cargo, not Vite — don't restart on them.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri v2's minimum webviews: Edge WebView2 (Chromium) / WKWebView / WebKitGTK.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: "../dist",
    emptyOutDir: true,
  },
});
