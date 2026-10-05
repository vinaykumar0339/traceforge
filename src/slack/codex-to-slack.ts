import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { SlackTask } from "./slack.streaming.js";
import { SlackStreamingService } from "./slack.streaming.js";

/** Converts official Codex SDK events into safe, useful Slack stream updates. */
export class CodexToSlackMapper {
  private readonly emittedMessageText = new Map<string, string>();

  constructor(private readonly streaming: SlackStreamingService, private readonly responseId: string) {}

  handle(event: ThreadEvent): void {
    switch (event.type) {
      case "thread.started": return this.threadStarted(event.thread_id);
      case "turn.started": return this.turnStarted();
      case "turn.completed": return this.turnCompleted();
      case "turn.failed": return this.turnFailed();
      case "item.started": return this.itemStarted(event.item);
      case "item.updated": return this.itemUpdated(event.item);
      case "item.completed": return this.itemCompleted(event.item);
      case "error": return this.streamError();
    }
  }

  private threadStarted(_threadId: string): void { this.task("codex-session", "Codex investigation session started", "complete"); }
  private turnStarted(): void { this.task("codex-turn", "Analyzing the issue", "in_progress"); }
  private turnCompleted(): void { this.task("codex-turn", "Analysis complete", "complete"); }
  private turnFailed(): void { this.task("codex-turn", "Codex could not complete the investigation", "error", "Review server logs for details"); }
  private streamError(): void { this.task("codex-stream", "Codex stream encountered an error", "error", "Review server logs for details"); }

  private itemStarted(item: ThreadItem): void { this.item(item, false); }
  private itemUpdated(item: ThreadItem): void { this.item(item, false); }
  private itemCompleted(item: ThreadItem): void { this.item(item, true); }

  private item(item: ThreadItem, completed: boolean): void {
    switch (item.type) {
      case "agent_message": return this.agentMessage(item.id, item.text);
      case "command_execution": return this.command(item.id, item.command, item.status, completed);
      case "file_change": return this.fileChange(item.id, item.changes.length, item.status);
      case "todo_list": return this.todoList(item.id, item.items, completed);
      case "web_search": return this.webSearch(item.id, completed);
      case "mcp_tool_call": return this.mcpTool(item.id, item.status);
      case "error": return this.itemError(item.id);
      case "reasoning": return; // Internal reasoning is deliberately never sent to Slack.
    }
  }

  private agentMessage(id: string, text: string): void {
    const previous = this.emittedMessageText.get(id) ?? "";
    if (text.startsWith(previous)) {
      const delta = text.slice(previous.length);
      if (delta) this.streaming.appendResponse(this.responseId, delta);
    } else if (text && text !== previous) {
      this.streaming.appendResponse(this.responseId, text);
    }
    this.emittedMessageText.set(id, text);
  }

  private command(id: string, command: string, status: "in_progress" | "completed" | "failed", completed: boolean): void {
    this.task(`command-${id}`, commandTitle(command), status === "failed" ? "error" : completed || status === "completed" ? "complete" : "in_progress", status === "failed" ? "Command did not complete" : completed ? "Completed" : undefined);
  }
  private fileChange(id: string, count: number, status: "completed" | "failed"): void { this.task(`file-${id}`, count ? `Updating ${count} workspace file${count === 1 ? "" : "s"}` : "Updating isolated workspace", status === "failed" ? "error" : "complete"); }
  private todoList(id: string, items: Array<{ text: string; completed: boolean }>, completed: boolean): void {
    const steps: SlackTask[] = items.map((item, index) => ({ id: `plan-${id}-${index}`, title: item.text, status: item.completed ? "complete" : completed ? "complete" : "in_progress" }));
    this.streaming.setPlan(this.responseId, "Investigation plan", steps);
  }
  private webSearch(id: string, completed: boolean): void { this.task(`web-${id}`, "Researching relevant external references", completed ? "complete" : "in_progress"); }
  private mcpTool(id: string, status: "in_progress" | "completed" | "failed"): void { this.task(`tool-${id}`, "Using a configured development tool", status === "failed" ? "error" : status === "completed" ? "complete" : "in_progress", status === "failed" ? "Tool did not complete" : undefined); }
  private itemError(id: string): void { this.task(`error-${id}`, "Codex reported a non-fatal issue", "error", "Continuing investigation"); }
  private task(id: string, title: string, status: SlackTask["status"], details?: string): void { this.streaming.updateTask(this.responseId, { id, title, status, details }); }
}

function commandTitle(command: string): string {
  if (/\bgit\s.*\blog\b/i.test(command)) return "Reviewing recent Git history";
  if (/\brg\b|\bgrep\b|\bfind\b/i.test(command)) return "Searching relevant source code";
  if (/\b(test|jest|vitest|gradle|xcodebuild)\b/i.test(command)) return "Running relevant tests";
  if (/\bgit\s+(diff|status)\b/i.test(command)) return "Reviewing workspace changes";
  return "Inspecting relevant implementation";
}
