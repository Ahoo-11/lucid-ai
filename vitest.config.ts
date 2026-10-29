import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // Server and CLI tests each boot an embedded Postgres (PGlite); with test
    // files running in parallel that can take longer than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
