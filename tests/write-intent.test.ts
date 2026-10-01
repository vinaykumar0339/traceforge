import { describe, expect, it } from "vitest";
import { parseWriteScope } from "../src/investigation/write-intent.js";

describe("semantic write intent response parsing", () => {
  it("accepts a constrained request to patch and publish", () => {
    expect(parseWriteScope('{"scope":"PUSH","confidence":0.98}')).toBe("PUSH");
  });

  it("keeps a question read-only", () => {
    expect(parseWriteScope('{"scope":"READ_ONLY","confidence":0.99}')).toBe("READ_ONLY");
  });

  it("fails closed when the model output is invalid", () => {
    expect(parseWriteScope("please push it")).toBeNull();
  });

  it("parses low-confidence responses but leaves enforcement to the classifier", () => {
    expect(parseWriteScope('{"scope":"PATCH","confidence":0.2}')).toBe("PATCH");
  });
});
