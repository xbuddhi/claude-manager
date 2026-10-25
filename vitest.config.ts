import { defineConfig } from "vitest/config";

// Unit tests live next to the code as *.test.ts and run in a simulated DOM; nothing here needs Tauri.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
