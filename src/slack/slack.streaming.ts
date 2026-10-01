import type { SlackApi, SlackBlock, SlackMessage } from "./slack.client.js";

interface ActiveResponse { channel: string; ts: string; native: boolean; text: string; pending: string; progress: string[]; timer?: NodeJS.Timeout; }
export interface StreamingRecipient { userId?: string; teamId?: string }

export class SlackStreamingService {
  private readonly active = new Map<string, ActiveResponse>();
  constructor(private readonly slack: SlackApi, private readonly intervalMs: number, private readonly mode: "auto" | "native" | "updates") {}
  postRootMessage(channel: string, message: SlackMessage): Promise<{ ts: string }> { return this.slack.postMessage({ channel, ...message }); }
  postThreadMessage(channel: string, threadTs: string, message: SlackMessage): Promise<{ ts: string }> { return this.slack.postMessage({ channel, threadTs, ...message }); }
  updateMessage(channel: string, ts: string, message: SlackMessage): Promise<void> { return this.slack.updateMessage({ channel, ts, ...message }); }
  async startResponse(channel: string, threadTs: string, message: SlackMessage, recipient?: StreamingRecipient): Promise<string> {
    if (this.mode !== "updates" && recipient?.userId && recipient.teamId) {
      try {
        const native = await this.slack.startStream({ channel, threadTs, recipientUserId: recipient.userId, recipientTeamId: recipient.teamId, markdownText: message.text });
        this.active.set(native.ts, { channel, ts: native.ts, native: true, text: "", pending: "", progress: [] }); return native.ts;
      } catch (error) { if (this.mode === "native") throw error; }
    }
    const posted = await this.slack.postMessage({ channel, threadTs, ...message });
    this.active.set(posted.ts, { channel, ts: posted.ts, native: false, text: "", pending: "", progress: [] }); return posted.ts;
  }
  appendResponse(responseTs: string, text: string): void { const active = this.active.get(responseTs); if (!active || !text.trim()) return; active.text += text; active.pending += text; this.schedule(responseTs, active); }
  setProgress(responseTs: string, progress: string): void { const active = this.active.get(responseTs); if (!active) return; if (active.progress.at(-1) !== progress) active.progress.push(progress); this.schedule(responseTs, active); }
  async finishResponse(responseTs: string, message: SlackMessage): Promise<void> {
    const active = this.active.get(responseTs); if (!active) return; if (active.timer) clearTimeout(active.timer);
    if (active.native) { if (active.pending) await this.slack.appendStream({ channel: active.channel, ts: responseTs, markdownText: active.pending }); await this.slack.stopStream({ channel: active.channel, ts: responseTs, blocks: message.blocks, sessionStatus: "closed" }); }
    else await this.slack.updateMessage({ channel: active.channel, ts: responseTs, ...message }); this.active.delete(responseTs);
  }
  async sendError(responseTs: string, message: SlackMessage): Promise<void> { await this.finishResponse(responseTs, message); }
  private schedule(responseTs: string, active: ActiveResponse): void { if (!active.timer) active.timer = setTimeout(() => { void this.flush(responseTs).catch(() => undefined); }, this.intervalMs); }
  private async flush(responseTs: string): Promise<void> {
    const active = this.active.get(responseTs); if (!active) return; active.timer = undefined;
    if (active.native) { if (active.pending) { const pending = active.pending; active.pending = ""; await this.slack.appendStream({ channel: active.channel, ts: responseTs, markdownText: pending }); } return; }
    await this.slack.updateMessage({ channel: active.channel, ts: responseTs, text: "Investigation in progress", blocks: progressBlocks(active.progress, active.text) });
  }
}
function progressBlocks(progress: string[], text: string): SlackBlock[] { const steps = progress.slice(-4).map((item) => `• ${item}`).join("\n") || "• Preparing investigation"; const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: "🔍 Investigation in progress" } }, { type: "section", text: { type: "mrkdwn", text: steps } }]; if (text.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2_800) } }); return blocks; }
