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
});
