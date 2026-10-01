import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeJiraIssue } from "../src/jira/jira.service.js";
import { parseJiraWebhook, verifyJiraSignature } from "../src/jira/jira.webhook.js";
import { parseSlackEnvelope, parseSlackInteraction, verifySlackSignature } from "../src/slack/slack.events.js";

describe("Jira webhook handling", () => {
  it("verifies raw payload signatures and parses supported events", () => {
    const raw = Buffer.from('{"webhookEvent":"jira:issue_created","issue":{"id":"7","key":"TF-7"}}');
    const secret = "a-safe-secret-value";
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    expect(verifyJiraSignature(raw, signature, secret)).toBe(true);
    expect(parseJiraWebhook(JSON.parse(raw.toString()))).toMatchObject({ webhookEvent: "jira:issue_created", issue: { key: "TF-7" } });
    expect(parseJiraWebhook({ webhookEvent: "board_created", issue: { id: "7", key: "TF-7" } })).toBeNull();
  });

  it("normalizes Jira fields without trusting the webhook shape", () => {
    const issue = normalizeJiraIssue({ id: "7", key: "TF-7", fields: { summary: "Save fails", labels: ["backend"], status: { name: "Open" }, description: { content: [{ content: [{ text: "Steps" }] }] }, comment: { comments: [{ id: "1", body: "More detail", author: { displayName: "Ada" } }] }, customfield_10001: "value" } });
    expect(issue).toMatchObject({ key: "TF-7", summary: "Save fails", description: "Steps", labels: ["backend"], comments: [{ author: "Ada" }], customFields: { customfield_10001: "value" } });
  });
});

describe("Slack Events API handling", () => {
  it("accepts valid signatures and emits only human thread replies", () => {
    const raw = Buffer.from('{"type":"event_callback","event_id":"Ev1","team_id":"T1","event":{"type":"message","channel":"C1","thread_ts":"1.0","text":"Check iOS","user":"U1"}}');
    const secret = "another-safe-secret";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    expect(verifySlackSignature(raw, timestamp, signature, secret)).toBe(true);
    expect(parseSlackEnvelope(JSON.parse(raw.toString())).message).toEqual({ eventId: "Ev1", channelId: "C1", threadTs: "1.0", text: "Check iOS", userId: "U1", teamId: "T1" });
    expect(parseSlackEnvelope({ type: "event_callback", event_id: "Ev2", team_id: "T1", event: { type: "message", channel: "C1", thread_ts: "1.0", text: "ignore", bot_id: "B1" } }).message).toBeUndefined();
  });

  it("parses an approval button action without trusting its text", () => {
    expect(parseSlackInteraction({ type: "block_actions", user: { id: "U1" }, container: { channel_id: "G1", message_ts: "2.0" }, actions: [{ action_id: "approval_approve", value: "approval-id", action_ts: "3.0" }] })).toEqual({ approvalId: "approval-id", decision: "approve", userId: "U1", channelId: "G1", messageTs: "2.0", interactionId: "U1:3.0:approval-id" });
  });
});
