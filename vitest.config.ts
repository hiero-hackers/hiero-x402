import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Ratchet, don't rot: floors sit at the current numbers so coverage can
      // only be lowered deliberately, never silently. src/ is at 100 today —
      // keep it there as verify/receipt land, or lower a floor with a reason.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});
