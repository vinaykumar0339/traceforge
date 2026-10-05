import { describe, expect, it } from "vitest";
import { CodexRunner } from "../src/agent/codex.runner.js";

describe("CodexRunner", () => {
  it("surfaces child-process start failures without invoking a shell", async () => {
    const runner = new CodexRunner("traceforge-command-does-not-exist");
    await expect(runner.run({ workspacePath: process.cwd(), prompt: "untrusted; $(whoami)", timeoutMs: 1_000 })).rejects.toThrow();
  });
});
