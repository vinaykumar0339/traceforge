import { describe, expect, it } from "vitest";
import { normalizeJiraIssue } from "../src/jira/jira.service.js";
import { extractJiraIssueKey, parseSlackInteraction, parseSlackSocketMention, parseSlackSocketTrigger } from "../src/slack/slack.events.js";

describe("Jira issue handling", () => {
  it("normalizes Jira fields received through the REST API", () => {
    const issue = normalizeJiraIssue({ id: "7", key: "TF-7", fields: { summary: "Save fails", labels: ["backend"], status: { name: "Open" }, description: { content: [{ content: [{ text: "Steps" }] }] }, comment: { comments: [{ id: "1", body: "More detail", author: { displayName: "Ada" } }] }, customfield_10001: "value" } });
    expect(issue).toMatchObject({ key: "TF-7", summary: "Save fails", description: "Steps", labels: ["backend"], comments: [{ author: "Ada" }], customFields: { customfield_10001: "value" } });
  });
});

describe("Slack Socket Mode handling", () => {
  it("parses an app mention with either an issue key or a Jira browse link", () => {
    const fromKey = parseSlackSocketTrigger({ type: "event_callback", event_id: "Ev1", team_id: "T1", event: { type: "app_mention", channel: "C1", ts: "1.0", text: "<@B1> investigate TF-123 check Android too", user: "U1" } });
    expect(fromKey).toMatchObject({ eventId: "Ev1", channelId: "C1", threadTs: "1.0", issueKey: "TF-123", question: "Investigate TF-123. Additional request: check Android too" });
    const fromLink = parseSlackSocketTrigger({ type: "event_callback", event_id: "Ev2", team_id: "T1", event: { type: "app_mention", channel: "C1", ts: "2.0", text: "<@B1> investigate <https://example.atlassian.net/browse/TF-456|TF-456>", user: "U1" } });
    expect(fromLink).toMatchObject({ issueKey: "TF-456", question: "Investigate Jira issue TF-456." });
    expect(extractJiraIssueKey("https://example.atlassian.net/browse/abc-7")).toBe("ABC-7");
    expect(extractJiraIssueKey("https://example.atlassian.net/jira/software/c/projects/abc/issues/8")).toBe("ABC-8");
    expect(parseSlackSocketTrigger({ type: "event_callback", event_id: "Ev3", team_id: "T1", event: { type: "app_mention", channel: "C1", ts: "3.0", text: "<@B1> TF-123", user: "U1" } })).toMatchObject({ issueKey: "TF-123" });
    expect(parseSlackSocketTrigger({ type: "event_callback", event_id: "Ev5", team_id: "T1", event: { type: "app_mention", channel: "C1", ts: "5.0", text: "<@B1> please check https://example.atlassian.net/browse/TAI-4", user: "U1" } })).toMatchObject({ issueKey: "TAI-4", question: "Investigate TAI-4. Additional request: please check" });
    expect(parseSlackSocketTrigger({ type: "event_callback", event_id: "Ev6", team_id: "T1", event: { type: "app_mention", channel: "C1", ts: "6.0", text: "<@B1> hi, how are you?", user: "U1" } })).toBeNull();
    expect(parseSlackSocketMention({ type: "event_callback", event_id: "Ev4", team_id: "T1", event: { type: "app_mention", channel: "C1", thread_ts: "1.0", ts: "4.0", text: "<@B1> Check iOS too", user: "U1" } })).toMatchObject({ eventId: "Ev4", threadTs: "1.0", text: "<@B1> Check iOS too" });
  });

  it("parses an approval button action without trusting its text", () => {
    expect(parseSlackInteraction({ type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, container: { channel_id: "G1", message_ts: "2.0" }, actions: [{ action_id: "approval_approve", value: "approval-id", action_ts: "3.0" }] })).toEqual({ kind: "approval", approvalId: "approval-id", decision: "approve", userId: "U1", teamId: "T1", channelId: "G1", messageTs: "2.0", interactionId: "U1:3.0:approval-id" });
  });

  it("parses stop controls as investigation actions", () => {
    expect(parseSlackInteraction({ type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, container: { channel_id: "G1", message_ts: "2.0" }, actions: [{ action_id: "investigation_stop", value: "investigation-id", action_ts: "3.0" }] })).toMatchObject({ kind: "control", action: "stop", investigationId: "investigation-id", userId: "U1" });
  });
});
