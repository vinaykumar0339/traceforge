import { spawn } from "node:child_process";

export interface CodexRunOptions {
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  mode?: "read-only" | "workspace-write";
  onEvent?: (event: CodexStreamEvent) => void;
}

export type CodexStreamEvent = { type: "message"; text: string } | { type: "progress"; text: string };

export interface CodexRunResult {
  exitCode: number;
  output: string;
  error?: string;
}

export class CodexRunner {
  constructor(private readonly command: string) {}

  run(options: CodexRunOptions): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["exec", "--json", "--sandbox", options.mode ?? "read-only", "--skip-git-repo-check", options.prompt], {
        cwd: options.workspacePath, shell: false, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
      let pending = "";
      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString(); output += chunk; pending += chunk;
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        lines.forEach((line) => { const event = parseStreamEvent(line); if (event) options.onEvent?.(event); });
      });
      child.stderr.on("data", (data: Buffer) => { error += data.toString(); });
      child.on("error", (spawnError) => { clearTimeout(timer); reject(spawnError); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return resolve({ exitCode: code ?? 1, output, error: `Codex timed out after ${options.timeoutMs}ms${error ? `: ${error}` : ""}` });
        resolve({ exitCode: code ?? 1, output, error: error || undefined });
      });
    });
  }
}

function parseStreamEvent(line: string): CodexStreamEvent | null {
  try {
    const value = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string; command?: string } };
    if (value.item?.type === "agent_message" && typeof value.item.text === "string") return { type: "message", text: value.item.text };
    if (value.item?.type === "command_execution") return { type: "progress", text: progressForCommand(value.item.command ?? "") };
  } catch { /* Codex JSONL is retained for persistence but never sent to Slack. */ }
  return null;
}

function progressForCommand(command: string): string {
  if (/git\s.*\blog\b/i.test(command)) return "Reviewing recent Git history";
  if (/\brg\b|\bgrep\b|\bfind\b/i.test(command)) return "Searching relevant source code";
  if (/\b(test|jest|vitest|gradle|xcodebuild)\b/i.test(command)) return "Checking relevant tests";
  return "Inspecting relevant implementation";
}
