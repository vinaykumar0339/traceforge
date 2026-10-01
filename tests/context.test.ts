import { describe, expect, it } from "vitest";
import { buildCodexPrompt } from "../src/agent/codex.context.js";

describe("Codex prompt generation", () => {
  it("includes available repositories and the exact follow-up question", () => {
    const prompt = buildCodexPrompt({ jira: { id: "1", key: "TF-1", summary: "Crash", description: null, status: null, priority: null, labels: [], components: [], issueType: null, reporter: null, assignee: null, project: null, comments: [], attachments: [], customFields: {}, raw: {} }, repositories: [{ repositoryName: "ios", sourcePath: "/repos/ios", workspacePath: "/work/ios", branch: "bugfix/codex-TF-1-crash", commitSha: "abc" }], previousFindings: [], recentEvents: [], currentQuestion: "Is this also happening in iOS?", workspacePath: "/work", investigationMarkdown: "# prior" });
    expect(prompt).toContain("Is this also happening in iOS?");
    expect(prompt).toContain('"repositoryName": "ios"');
    expect(prompt).toContain("Do not modify application code");
  });
});
