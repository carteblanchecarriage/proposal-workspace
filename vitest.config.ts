import { defineConfig } from "vitest/config";

// Unit tests (test/**/*.test.ts). Kept apart from vite.config.ts, whose plugins run the dev API and Svelte: tests
// need neither. `npm test` runs them once; the build runs them too, so a failing test stops a deploy.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // A fixed key, so encryption tests never touch a real one (and the real one is never needed to run them).
    env: { DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), TZ: "UTC" },
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/fee-calc.ts", "src/fee-style.ts", "src/fee-chat.ts", "lib/crypt.ts", "lib/cost.ts", "lib/admin.ts", "lib/schedule-style.ts"],
      reporter: ["text-summary", "text"],
    },
  },
});
