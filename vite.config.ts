import { defineConfig } from "vite";

// SharedArrayBuffer（AIのマルチスレッド）に必要なヘッダー。
// 本番（GitHub Pages）では public/sw.js が同じヘッダーを付ける。
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: "es2022", chunkSizeWarningLimit: 1000 },
});
