import { configDefaults, mergeConfig } from "vitest/config";
import shared from "./vitest.shared.mts";

export default mergeConfig(shared, {
  test: {
    exclude: [...configDefaults.exclude, "**/*.dist-smoke.test.ts"]
  }
});
