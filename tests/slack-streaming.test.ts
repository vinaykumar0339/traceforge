import { describe, expect, it, vi } from "vitest";
import { SlackStreamingService } from "../src/slack/slack.streaming.js";

describe("SlackStreamingService", () => {
  it("creates a root message for an investigation in its destination channel", async () => {
    const api = { postMessage: vi.fn().mockResolvedValue({ ts: "2.0" }), updateMessage: vi.fn(), createStream: vi.fn() };
    const service = new SlackStreamingService(api, 1_000, "updates");

    await expect(service.postRootMessage("C-destination", { text: "Investigation started" })).resolves.toEqual({ ts: "2.0" });
    expect(api.postMessage).toHaveBeenCalledWith({ channel: "C-destination", text: "Investigation started" });
  });

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
    const nativeStream = { append: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const api = { postMessage: vi.fn(), updateMessage: vi.fn(), createStream: vi.fn().mockReturnValue(nativeStream) };
    const service = new SlackStreamingService(api, 1_000, "native");
    const responseTs = await service.startResponse("C1", "1.0", { text: "Investigating" }, { userId: "U1", teamId: "T1" });
    service.appendResponse(responseTs, "Finding the issue…");
    service.updateTask(responseTs, { id: "command-1", title: "Searching source code", status: "complete", details: "Completed in 0.2s" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.createStream).toHaveBeenCalledWith(expect.objectContaining({ channel: "C1", threadTs: "1.0" }));
    expect(nativeStream.append).toHaveBeenCalledWith({ chunks: [expect.objectContaining({ type: "task_update" })] });
    expect(nativeStream.append).toHaveBeenCalledWith({ chunks: expect.arrayContaining([expect.objectContaining({ type: "markdown_text" }), expect.objectContaining({ type: "task_update", status: "complete" })]) });
    await service.finishResponse(responseTs, { text: "done", blocks: [] });
    expect(nativeStream.stop).toHaveBeenCalledWith({ blocks: [] });
    vi.useRealTimers();
  });

  it("keeps concurrent native streams isolated and finalizes each stream", async () => {
    const first = { append: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const second = { append: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const api = { postMessage: vi.fn(), updateMessage: vi.fn(), createStream: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) };
    const service = new SlackStreamingService(api, 1_000, "native");

    const one = await service.startResponse("C1", "1.0", { text: "Investigating" }, { userId: "U1", teamId: "T1" });
    const two = await service.startResponse("C2", "2.0", { text: "Investigating" }, { userId: "U2", teamId: "T2" });
    service.appendResponse(one, "First issue");
    service.appendResponse(two, "Second issue");
    await service.finishResponse(one, { text: "First complete" });
    await service.finishResponse(two, { text: "Second complete" });

    expect(first.append).toHaveBeenCalledWith({ chunks: expect.arrayContaining([expect.objectContaining({ text: "First issue" })]) });
    expect(second.append).toHaveBeenCalledWith({ chunks: expect.arrayContaining([expect.objectContaining({ text: "Second issue" })]) });
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
  });

  it("finalizes a native stream after an error response", async () => {
    const nativeStream = { append: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) };
    const api = { postMessage: vi.fn(), updateMessage: vi.fn(), createStream: vi.fn().mockReturnValue(nativeStream) };
    const service = new SlackStreamingService(api, 1_000, "native");
    const responseTs = await service.startResponse("C1", "1.0", { text: "Investigating" }, { userId: "U1", teamId: "T1" });

    await service.sendError(responseTs, { text: "Investigation failed" });

    expect(nativeStream.stop).toHaveBeenCalledWith({ blocks: undefined });
  });
});
