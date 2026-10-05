import { describe, expect, it, vi } from "vitest";
import { CodexToSlackMapper } from "../src/slack/codex-to-slack.js";

describe("CodexToSlackMapper", () => {
  it("maps useful lifecycle and item events without exposing reasoning or command output", () => {
    const streaming = { appendResponse: vi.fn(), updateTask: vi.fn(), setPlan: vi.fn() };
    const mapper = new CodexToSlackMapper(streaming as never, "response-1");

    mapper.handle({ type: "turn.started" });
    mapper.handle({ type: "item.started", item: { id: "cmd-1", type: "command_execution", command: "pnpm test -- --secret=never-show", aggregated_output: "private output", status: "in_progress" } });
    mapper.handle({ type: "item.updated", item: { id: "message-1", type: "agent_message", text: "Root cause" } });
    mapper.handle({ type: "item.completed", item: { id: "message-1", type: "agent_message", text: "Root cause found" } });
    mapper.handle({ type: "item.completed", item: { id: "reason-1", type: "reasoning", text: "never send this" } });
    mapper.handle({ type: "item.updated", item: { id: "plan-1", type: "todo_list", items: [{ text: "Inspect Android flow", completed: true }] } });
    mapper.handle({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });

    expect(streaming.appendResponse).toHaveBeenNthCalledWith(1, "response-1", "Root cause");
    expect(streaming.appendResponse).toHaveBeenNthCalledWith(2, "response-1", " found");
    expect(streaming.updateTask).toHaveBeenCalledWith("response-1", expect.objectContaining({ title: "Running relevant tests" }));
    expect(streaming.updateTask).not.toHaveBeenCalledWith("response-1", expect.objectContaining({ title: expect.stringContaining("secret") }));
    expect(streaming.setPlan).toHaveBeenCalledWith("response-1", "Investigation plan", [expect.objectContaining({ title: "Inspect Android flow", status: "complete" })]);
  });
});
