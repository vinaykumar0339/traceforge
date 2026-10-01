import { WebClient } from "@slack/web-api";

export type SlackBlock = Record<string, unknown>;
export interface SlackMessage { text: string; blocks?: SlackBlock[] }
export interface SlackApi {
  postMessage(input: { channel: string; threadTs?: string } & SlackMessage): Promise<{ ts: string }>;
  updateMessage(input: { channel: string; ts: string } & SlackMessage): Promise<void>;
  startStream(input: { channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string; markdownText: string }): Promise<{ ts: string }>;
  appendStream(input: { channel: string; ts: string; markdownText: string }): Promise<void>;
  stopStream(input: { channel: string; ts: string; markdownText?: string; blocks?: SlackBlock[]; sessionStatus?: "closed" | "processing" }): Promise<void>;
}

export class SlackClient implements SlackApi {
  private readonly client: WebClient;
  constructor(private readonly token: string) { this.client = new WebClient(token); }
  async postMessage(input: { channel: string; threadTs?: string } & SlackMessage): Promise<{ ts: string }> {
    const result = await this.client.chat.postMessage({ channel: input.channel, text: input.text, thread_ts: input.threadTs, blocks: input.blocks as never });
    if (!result.ts) throw new Error("Slack did not return a message timestamp");
    return { ts: result.ts };
  }
  async updateMessage(input: { channel: string; ts: string } & SlackMessage): Promise<void> { await this.client.chat.update({ channel: input.channel, ts: input.ts, text: input.text, blocks: input.blocks as never }); }
  async startStream(input: { channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string; markdownText: string }): Promise<{ ts: string }> {
    return this.callStream("chat.startStream", { channel: input.channel, thread_ts: input.threadTs, recipient_user_id: input.recipientUserId, recipient_team_id: input.recipientTeamId, markdown_text: input.markdownText });
  }
  async appendStream(input: { channel: string; ts: string; markdownText: string }): Promise<void> { await this.callStream("chat.appendStream", { channel: input.channel, ts: input.ts, markdown_text: input.markdownText }); }
  async stopStream(input: { channel: string; ts: string; markdownText?: string; blocks?: SlackBlock[]; sessionStatus?: "closed" | "processing" }): Promise<void> { await this.callStream("chat.stopStream", { channel: input.channel, ts: input.ts, markdown_text: input.markdownText, blocks: input.blocks, session_status: input.sessionStatus ?? "closed" }); }
  private async callStream(method: string, body: Record<string, unknown>): Promise<{ ts: string }> {
    const response = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const payload = await response.json() as { ok?: boolean; error?: string; ts?: string };
    if (!response.ok || !payload.ok) throw new Error(`Slack ${method} failed: ${payload.error ?? response.status}`);
    return { ts: payload.ts ?? "" };
  }
}
