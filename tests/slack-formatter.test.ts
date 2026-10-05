import { describe, expect, it } from "vitest";
import { SlackFormatter, toSlackEvidence } from "../src/slack/slack.service.js";

const source = {
  repositoryName: "android",
  platform: "android",
  sourcePath: "/repos/android",
  workspacePath: "/workspaces/TAI-1/android",
  branch: "bugfix/codex-TAI-1-keyboard-submit",
  commitSha: "abc123",
};

describe("toSlackEvidence", () => {
  it("renders local source evidence cleanly without a browser URL", () => {
    const result = toSlackEvidence("See [ValidateUserIdFragment.java](/workspaces/TAI-1/android/library/Login.java:122).", [source]);
    expect(result).toBe("See *ValidateUserIdFragment.java* — `android/library/Login.java:122`.");
  });

  it("creates a Slack permalink when the repository provides a source URL template", () => {
    const result = toSlackEvidence("See [ValidateUserIdFragment.java](/workspaces/TAI-1/android/library/Login.java:122).", [{ ...source, sourceUrlTemplate: "https://github.com/acme/android/blob/{ref}/{path}#L{line}" }]);
    expect(result).toBe("See <https://github.com/acme/android/blob/abc123/library/Login.java#L122|ValidateUserIdFragment.java>.");
  });

  it("uses Bitbucket Cloud's file-name line anchor", () => {
    const result = toSlackEvidence("See [ValidateUserIdFragment.java](/workspaces/TAI-1/android/library/Login.java:122).", [{ ...source, sourceUrlTemplate: "https://bitbucket.org/acme/android/src/{ref}/{path}#{file}-{line}" }]);
    expect(result).toBe("See <https://bitbucket.org/acme/android/src/abc123/library/Login.java#Login.java-122|ValidateUserIdFragment.java>.");
  });
});

describe("SlackFormatter controls", () => {
  it("retires a Stop button once its run is no longer active", () => {
    const message = new SlackFormatter().inactiveRun("TAI-1");
    expect(message.text).toContain("no longer running");
    expect(message.blocks?.some((block) => block.type === "actions")).toBe(false);
  });

  it("offers resumable controls for a timed-out investigation", () => {
    const message = new SlackFormatter().pausedControls({ investigationId: "investigation-id", issueKey: "TAI-4", reason: "Codex reached its configured time limit." });
    expect(message.text).toBe("TAI-4 paused");
    expect(message.blocks).toContainEqual(expect.objectContaining({ type: "actions", elements: expect.arrayContaining([
      expect.objectContaining({ action_id: "investigation_continue" }),
      expect.objectContaining({ action_id: "investigation_dismiss" }),
    ]) }));
  });
});
