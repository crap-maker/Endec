import { mergeConfig } from "vitest/config";
import shared from "../../vitest.shared.mts";

export default mergeConfig(shared, {
  test: {
    include: ["src/**/*.dist-smoke.test.ts"]
  }
});
