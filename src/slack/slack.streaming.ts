import type { SlackApi, SlackBlock, SlackMessage, SlackStreamChunk } from "./slack.client.js";

export interface StreamingRecipient { userId?: string; teamId?: string }
type Task = { id: string; title: string; status: "in_progress" | "complete" | "error"; details?: string };
interface ActiveResponse {
  channel: string; ts: string; native: boolean; text: string; pending: SlackStreamChunk[]; tasks: Map<string, Task>; planTitle?: string; timer?: NodeJS.Timeout;
}

export class SlackStreamingService {
  private readonly active = new Map<string, ActiveResponse>();
  constructor(private readonly slack: SlackApi, private readonly intervalMs: number, private readonly mode: "auto" | "native" | "updates") {}

  postRootMessage(channel: string, message: SlackMessage): Promise<{ ts: string }> { return this.slack.postMessage({ channel, ...message }); }
  postThreadMessage(channel: string, threadTs: string, message: SlackMessage): Promise<{ ts: string }> { return this.slack.postMessage({ channel, threadTs, ...message }); }
  updateMessage(channel: string, ts: string, message: SlackMessage): Promise<void> { return this.slack.updateMessage({ channel, ts, ...message }); }

  async startResponse(channel: string, threadTs: string, message: SlackMessage, recipient?: StreamingRecipient): Promise<string> {
    const initialTask: Task = { id: "preparing", title: "Preparing investigation", status: "in_progress" };
    if (this.mode !== "updates" && recipient?.userId && recipient.teamId) {
      try {
        const native = await this.slack.startStream({ channel, threadTs, recipientUserId: recipient.userId, recipientTeamId: recipient.teamId, chunks: [taskChunk(initialTask)] });
        this.active.set(native.ts, { channel, ts: native.ts, native: true, text: "", pending: [], tasks: new Map([[initialTask.id, initialTask]]) });
        return native.ts;
      } catch (error) { if (this.mode === "native") throw error; }
    }
    const posted = await this.slack.postMessage({ channel, threadTs, ...message });
    this.active.set(posted.ts, { channel, ts: posted.ts, native: false, text: "", pending: [], tasks: new Map([[initialTask.id, initialTask]]) });
    return posted.ts;
  }

  appendResponse(responseTs: string, text: string): void {
    const active = this.active.get(responseTs);
    if (!active || !text) return;
    active.text += text;
    if (active.native) active.pending.push({ type: "markdown_text", text });
    this.schedule(responseTs, active);
  }

  setProgress(responseTs: string, progress: string): void { this.updateTask(responseTs, { id: `activity-${slug(progress)}`, title: progress, status: "in_progress" }); }
  updateTask(responseTs: string, task: Task): void {
    const active = this.active.get(responseTs);
    if (!active) return;
    active.tasks.set(task.id, task);
    if (active.native) active.pending.push(taskChunk(task));
    this.schedule(responseTs, active);
  }
  setPlan(responseTs: string, title: string, steps: Task[]): void {
    const active = this.active.get(responseTs);
    if (!active) return;
    active.planTitle = limit(title);
    for (const step of steps) active.tasks.set(step.id, { ...step, title: limit(step.title) });
    if (active.native) active.pending.push({ type: "plan_update", title: active.planTitle }, ...steps.map(taskChunk));
    this.schedule(responseTs, active);
  }

  async finishResponse(responseTs: string, message: SlackMessage): Promise<void> {
    const active = this.active.get(responseTs);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    if (active.native) {
      if (active.pending.length) await this.slack.appendStream({ channel: active.channel, ts: responseTs, chunks: active.pending });
      await this.slack.stopStream({ channel: active.channel, ts: responseTs, blocks: message.blocks, sessionStatus: "closed" });
    } else await this.slack.updateMessage({ channel: active.channel, ts: responseTs, ...message });
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
    if (active.native) {
      if (!active.pending.length) return;
      const chunks = active.pending.splice(0);
      await this.slack.appendStream({ channel: active.channel, ts: responseTs, chunks });
      return;
    }
    await this.slack.updateMessage({ channel: active.channel, ts: responseTs, text: "Investigation in progress", blocks: progressBlocks(active) });
  }
}

function taskChunk(task: Task): SlackStreamChunk { return { type: "task_update", id: task.id, title: limit(task.title), status: task.status, details: task.details ? limit(task.details) : undefined }; }
function progressBlocks(active: ActiveResponse): SlackBlock[] {
  const tasks = [...active.tasks.values()].slice(-6);
  const icon = (status: Task["status"]): string => status === "complete" ? "✅" : status === "error" ? "⚠️" : "◌";
  const taskText = tasks.map((task) => `${icon(task.status)} ${task.title}${task.details ? ` — ${task.details}` : ""}`).join("\n") || "◌ Preparing investigation";
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "🔍 Investigation in progress" } },
    ...(active.planTitle ? [{ type: "context", elements: [{ type: "mrkdwn", text: `*Plan:* ${active.planTitle}` }] }] : []),
    { type: "section", text: { type: "mrkdwn", text: taskText } },
  ];
  if (active.text.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: active.text.slice(-2_800) } });
  return blocks;
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80) || "activity"; }
function limit(value: string): string { return value.slice(0, 256); }
