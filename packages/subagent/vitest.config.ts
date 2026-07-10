import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/helpers/setup.ts"],
    testTimeout: 5000,
    isolate: true,
  },
});
