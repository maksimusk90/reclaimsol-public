import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    clearMocks: true,
    restoreMocks: true
  }
});