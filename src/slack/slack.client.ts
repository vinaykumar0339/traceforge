import { WebClient, type ChatStreamer } from "@slack/web-api";

export type SlackBlock = Record<string, unknown>;
export interface SlackMessage { text: string; blocks?: SlackBlock[] }
export type SlackStreamChunk =
  | { type: "markdown_text"; text: string }
  | { type: "task_update"; id: string; title: string; status: "in_progress" | "complete" | "error"; details?: string }
  | { type: "plan_update"; title: string };

export interface SlackNativeStream {
  append(input: { chunks: SlackStreamChunk[] }): Promise<void>;
  stop(input?: { markdownText?: string; blocks?: SlackBlock[] }): Promise<void>;
}

export interface SlackApi {
  postMessage(input: { channel: string; threadTs?: string } & SlackMessage): Promise<{ ts: string }>;
  updateMessage(input: { channel: string; ts: string } & SlackMessage): Promise<void>;
  createStream(input: { channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string }): SlackNativeStream;
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
  createStream(input: { channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string }): SlackNativeStream {
    const stream = this.client.chatStream({
      channel: input.channel,
      thread_ts: input.threadTs,
      recipient_user_id: input.recipientUserId,
      recipient_team_id: input.recipientTeamId,
      buffer_size: 512,
    });
    return new SlackChatStreamer(stream);
  }
}

/** Keeps the official Slack ChatStreamer behind Traceforge's small testable interface. */
class SlackChatStreamer implements SlackNativeStream {
  constructor(private readonly stream: ChatStreamer) {}
  async append(input: { chunks: SlackStreamChunk[] }): Promise<void> { await this.stream.append({ chunks: input.chunks as never }); }
  async stop(input: { markdownText?: string; blocks?: SlackBlock[] } = {}): Promise<void> {
    await this.stream.stop({ markdown_text: input.markdownText, blocks: input.blocks as never });
  }
}
