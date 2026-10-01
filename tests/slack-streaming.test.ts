import { describe, expect, it, vi } from "vitest";
import { SlackStreamingService } from "../src/slack/slack.streaming.js";

describe("SlackStreamingService", () => {
  it("coalesces output and writes one final response", async () => {
    vi.useFakeTimers();
    const api = { postMessage: vi.fn().mockResolvedValue({ ts: "2.0" }), updateMessage: vi.fn().mockResolvedValue(undefined), startStream: vi.fn(), appendStream: vi.fn(), stopStream: vi.fn() };
    const service = new SlackStreamingService(api, 1_000, "updates");
    const responseTs = await service.startResponse("C1", "1.0", { text: "Investigating" });
    service.appendResponse(responseTs, " first");
    service.appendResponse(responseTs, " second");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.updateMessage).toHaveBeenCalledTimes(1);
    await service.finishResponse(responseTs, { text: "done" });
    expect(api.updateMessage).toHaveBeenLastCalledWith({ channel: "C1", ts: "2.0", text: "done" });
    vi.useRealTimers();
  });

  it("streams Codex message deltas and task lifecycle chunks natively", async () => {
    vi.useFakeTimers();
    const api = { postMessage: vi.fn(), updateMessage: vi.fn(), startStream: vi.fn().mockResolvedValue({ ts: "2.0" }), appendStream: vi.fn().mockResolvedValue(undefined), stopStream: vi.fn().mockResolvedValue(undefined) };
    const service = new SlackStreamingService(api, 1_000, "native");
    const responseTs = await service.startResponse("C1", "1.0", { text: "Investigating" }, { userId: "U1", teamId: "T1" });
    service.appendResponse(responseTs, "Finding the issue…");
    service.updateTask(responseTs, { id: "command-1", title: "Searching source code", status: "complete", details: "Completed in 0.2s" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.startStream).toHaveBeenCalledWith(expect.objectContaining({ chunks: [expect.objectContaining({ type: "task_update" })] }));
    expect(api.appendStream).toHaveBeenCalledWith(expect.objectContaining({ chunks: expect.arrayContaining([expect.objectContaining({ type: "markdown_text" }), expect.objectContaining({ type: "task_update", status: "complete" })]) }));
    await service.finishResponse(responseTs, { text: "done", blocks: [] });
    expect(api.stopStream).toHaveBeenCalledWith(expect.objectContaining({ sessionStatus: "closed" }));
    vi.useRealTimers();
  });
});
