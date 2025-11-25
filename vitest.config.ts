import { defineConfig } from "vitest/config";

export default defineConfig({
    test: { globals: true },
    optimizeDeps: {
        include: ["devvit-helpers", "lodash"],
    },
    ssr: {
        noExternal: ["devvit-helpers", "lodash"],
    },
});
