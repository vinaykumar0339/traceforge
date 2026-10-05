import type { SlackApi, SlackBlock, SlackMessage, SlackNativeStream, SlackStreamChunk } from "./slack.client.js";

export interface StreamingRecipient { userId?: string; teamId?: string }
export type SlackTask = { id: string; title: string; status: "in_progress" | "complete" | "error"; details?: string };
interface ActiveResponse {
  channel: string; messageTs?: string; nativeStream?: SlackNativeStream; text: string; pending: SlackStreamChunk[]; tasks: Map<string, SlackTask>; planTitle?: string; timer?: NodeJS.Timeout;
}

export class SlackStreamingService {
  private readonly active = new Map<string, ActiveResponse>();
  constructor(private readonly slack: SlackApi, private readonly intervalMs: number, private readonly mode: "auto" | "native" | "updates") {}

  postRootMessage(channel: string, message: SlackMessage): Promise<{ ts: string }> { return this.slack.postMessage({ channel, ...message }); }
  postThreadMessage(channel: string, threadTs: string, message: SlackMessage): Promise<{ ts: string }> { return this.slack.postMessage({ channel, threadTs, ...message }); }
  updateMessage(channel: string, ts: string, message: SlackMessage): Promise<void> { return this.slack.updateMessage({ channel, ts, ...message }); }

  async startResponse(channel: string, threadTs: string, message: SlackMessage, recipient?: StreamingRecipient): Promise<string> {
    const initialTask: SlackTask = { id: "preparing", title: "Preparing investigation", status: "in_progress" };
    if (this.mode !== "updates" && recipient?.userId && recipient.teamId) {
      try {
        const nativeStream = this.slack.createStream({ channel, threadTs, recipientUserId: recipient.userId, recipientTeamId: recipient.teamId });
        await nativeStream.append({ chunks: [taskChunk(initialTask)] });
        const responseId = crypto.randomUUID();
        this.active.set(responseId, { channel, nativeStream, text: "", pending: [], tasks: new Map([[initialTask.id, initialTask]]) });
        return responseId;
      } catch (error) { if (this.mode === "native") throw error; }
    }
    const posted = await this.slack.postMessage({ channel, threadTs, ...message });
    const responseId = crypto.randomUUID();
    this.active.set(responseId, { channel, messageTs: posted.ts, text: "", pending: [], tasks: new Map([[initialTask.id, initialTask]]) });
    return responseId;
  }

  appendResponse(responseTs: string, text: string): void {
    const active = this.active.get(responseTs);
    if (!active || !text) return;
    active.text += text;
    if (active.nativeStream) active.pending.push({ type: "markdown_text", text });
    this.schedule(responseTs, active);
  }

  updateTask(responseTs: string, task: SlackTask): void {
    const active = this.active.get(responseTs);
    if (!active) return;
    active.tasks.set(task.id, task);
    if (active.nativeStream) active.pending.push(taskChunk(task));
    this.schedule(responseTs, active);
  }
  setPlan(responseTs: string, title: string, steps: SlackTask[]): void {
    const active = this.active.get(responseTs);
    if (!active) return;
    active.planTitle = limit(title);
    for (const step of steps) active.tasks.set(step.id, { ...step, title: limit(step.title) });
    if (active.nativeStream) active.pending.push({ type: "plan_update", title: active.planTitle }, ...steps.map(taskChunk));
    this.schedule(responseTs, active);
  }

  async finishResponse(responseTs: string, message: SlackMessage): Promise<void> {
    const active = this.active.get(responseTs);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    if (active.nativeStream) {
      if (active.pending.length) await active.nativeStream.append({ chunks: active.pending });
      await active.nativeStream.stop({ blocks: message.blocks });
    } else if (active.messageTs) await this.slack.updateMessage({ channel: active.channel, ts: active.messageTs, ...message });
    this.active.delete(responseTs);
  }
  async sendError(responseTs: string, message: SlackMessage): Promise<void> { await this.finishResponse(responseTs, message); }

  private schedule(responseTs: string, active: ActiveResponse): void {
    if (!active.timer) active.timer = setTimeout(() => { void this.flush(responseTs).catch(() => undefined); }, this.intervalMs);
  }
  private async flush(responseTs: string): Promise<void> {
    const active = this.active.get(responseTs);
    if (!active) return;
    active.timer = undefined;
    if (active.nativeStream) {
      if (!active.pending.length) return;
      const chunks = active.pending.splice(0);
      await active.nativeStream.append({ chunks });
      return;
    }
    if (active.messageTs) await this.slack.updateMessage({ channel: active.channel, ts: active.messageTs, text: "Investigation in progress", blocks: progressBlocks(active) });
  }
}

function taskChunk(task: SlackTask): SlackStreamChunk { return { type: "task_update", id: task.id, title: limit(task.title), status: task.status, details: task.details ? limit(task.details) : undefined }; }
function progressBlocks(active: ActiveResponse): SlackBlock[] {
  const tasks = [...active.tasks.values()].slice(-6);
  const icon = (status: SlackTask["status"]): string => status === "complete" ? "✅" : status === "error" ? "⚠️" : "◌";
  const taskText = tasks.map((task) => `${icon(task.status)} ${task.title}${task.details ? ` — ${task.details}` : ""}`).join("\n") || "◌ Preparing investigation";
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "🔍 Investigation in progress" } },
    ...(active.planTitle ? [{ type: "context", elements: [{ type: "mrkdwn", text: `*Plan:* ${active.planTitle}` }] }] : []),
    { type: "section", text: { type: "mrkdwn", text: taskText } },
  ];
  if (active.text.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: active.text.slice(-2_800) } });
  return blocks;
}
function limit(value: string): string { return value.slice(0, 256); }
