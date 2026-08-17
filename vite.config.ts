import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    sourcemap: false,
    // The deferred Three.js workspace is intentionally isolated from the
    // initial editor bundle and remains about 127 kB over the wire.
    chunkSizeWarningLimit: 550,
  },
});
