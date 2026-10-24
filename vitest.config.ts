import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // third_party/napcat 是上游仓库指针,里面的测试与我们无关
    exclude: ["**/node_modules/**", "third_party/**", ".zcode/**"],
  },
});
