import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // WebView2 is evergreen Chromium; macOS 12 ships WebKit from Safari 15, older than Vite's default target.
  build: {
    target: ["es2021", "chrome105", "safari15"],
    // the bundle loads from disk, not a network; xterm alone is most of its size
    chunkSizeWarningLimit: 1500,
    rolldownOptions: {
      // every HTML page of the app; a package adds its page under its own marker
      input: {
        main: page("index.html"),
        // WP2 terminal pop-out window (popout.html)
        popout: page("src/popout.html"),
      },
    },
  },
}));
