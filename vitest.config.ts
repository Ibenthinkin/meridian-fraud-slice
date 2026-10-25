import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The CDK assertion tests need aws-cdk-lib installed; they're excluded by
    // the "test:core" script so the pure logic can be checked on its own.
  },
});
