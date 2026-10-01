import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../src/workspace/workspace.manager.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("WorkspaceManager", () => {
  it("creates and reuses an isolated ticket worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "traceforge-test-")); roots.push(root);
    const source = path.join(root, "source");
    execFileSync("git", ["init", "-b", "main", source]);
    execFileSync("git", ["-C", source, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", source, "config", "user.name", "Test"]);
    await writeFile(path.join(source, "README.md"), "source");
    execFileSync("git", ["-C", source, "add", "."]); execFileSync("git", ["-C", source, "commit", "-m", "initial"]);
    const manager = new WorkspaceManager(path.join(root, "workspaces"), [{ name: "backend", platform: "backend", path: source, branch: "main" }], pino({ enabled: false }));
    const first = await manager.prepare("TF-7", "Save fails!");
    const second = await manager.prepare("TF-7", "Save fails!");
    expect(first.snapshots[0]?.branch).toBe("bugfix/codex-TF-7-save-fails");
    expect(second.snapshots[0]?.workspacePath).toBe(first.snapshots[0]?.workspacePath);
    expect(execFileSync("git", ["-C", source, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("main");
  }, 15_000);
});
