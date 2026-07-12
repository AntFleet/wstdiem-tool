import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.claude/**` holds agent-isolation git worktrees (full repo copies). Excluding it keeps
    // vitest from discovering duplicate test files there and racing them against the originals.
    exclude: ["dist/**", "node_modules/**", ".claude/**"],
    globals: false,
    environment: "node",
  },
});
