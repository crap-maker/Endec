import { describe, expect, it } from "vitest";
import { parseTelegramCommandIntent } from "./command-intent.ts";

describe("parseTelegramCommandIntent", () => {
  it("parses owner-only provider control subcommands and reveal flags", () => {
    expect(parseTelegramCommandIntent({
      text: "/provider key show --reveal",
      botUsername: "endec"
    })).toEqual({
      name: "provider",
      subcommand: "key",
      args: ["show"],
      options: { reveal: true },
      rawText: "/provider key show --reveal",
      helpRequested: false
    });
  });

  it("parses owner-only self-inspection subcommands", () => {
    expect(parseTelegramCommandIntent({
      text: "/inspect source packages/app/src/im-command-service.ts",
      botUsername: "endec"
    })).toEqual({
      name: "inspect",
      subcommand: "source",
      args: ["packages/app/src/im-command-service.ts"],
      options: {},
      rawText: "/inspect source packages/app/src/im-command-service.ts",
      helpRequested: false
    });
  });
});
