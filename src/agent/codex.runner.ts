import { spawn } from "node:child_process";
import readline from "node:readline";

export interface CodexRunOptions {
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  mode?: "read-only" | "workspace-write";
  allowNetwork?: boolean;
  outputSchema?: Record<string, unknown>;
  threadId?: string;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  onEvent?: (event: CodexStreamEvent) => void;
}

export type CodexTaskStatus = "in_progress" | "complete" | "error";
export type CodexStreamEvent =
  | { type: "message"; text: string }
  | { type: "task"; id: string; title: string; status: CodexTaskStatus; details?: string }
  | { type: "plan"; title: string; steps: Array<{ id: string; title: string; status: CodexTaskStatus }> }
  | { type: "file_change"; id: string; title: string; status: CodexTaskStatus; details?: string };

export interface CodexRunResult {
  exitCode: number;
  output: string;
  codexThreadId?: string;
  error?: string;
}

type RpcMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

/** A stdio JSON-RPC adapter for `codex app-server`. */
export class CodexRunner {
  constructor(private readonly command: string) {}

  run(options: CodexRunOptions): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["app-server"], { cwd: options.workspacePath, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      const sandbox = options.mode === "workspace-write" ? "workspace-write" : "read-only";
      const sandboxPolicy = options.mode === "workspace-write"
        ? { type: "workspaceWrite", writableRoots: [options.workspacePath], networkAccess: options.allowNetwork ?? false }
        : { type: "readOnly", networkAccess: false };
      const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
      const agentMessageIds = new Set<string>();
      let output = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let requestId = 0;
      let threadId = options.threadId;
      let turnId: string | undefined;

      const settle = (result: CodexRunResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const fail = (error: Error): void => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
      const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const id = ++requestId;
        return new Promise((resolveRequest, rejectRequest) => { pending.set(id, { resolve: resolveRequest, reject: rejectRequest }); send({ method, id, params }); });
      };
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);

      const onNotification = (message: RpcMessage): void => {
        const params = message.params ?? {};
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
          output += params.delta;
          if (typeof params.itemId === "string") agentMessageIds.add(params.itemId);
          options.onEvent?.({ type: "message", text: params.delta });
          return;
        }
        if (message.method === "turn/plan/updated" && Array.isArray(params.plan)) {
          const steps = params.plan.flatMap((step, index) => !isRecord(step) || typeof step.step !== "string" ? [] : [{ id: `plan-${index}`, title: step.step, status: planStatus(step.status) }]);
          options.onEvent?.({ type: "plan", title: typeof params.explanation === "string" ? params.explanation : "Investigation plan", steps });
          return;
        }
        if ((message.method === "item/started" || message.method === "item/completed") && isRecord(params.item)) {
          const item = params.item;
          const itemId = typeof item.id === "string" ? item.id : crypto.randomUUID();
          const completed = message.method === "item/completed";
          const status: CodexTaskStatus = completed && item.status === "failed" ? "error" : completed ? "complete" : "in_progress";
          if (item.type === "agentMessage" && completed && typeof item.text === "string" && !agentMessageIds.has(itemId)) output += item.text;
          if (item.type === "commandExecution") options.onEvent?.({ type: "task", id: `command-${itemId}`, title: commandTitle(typeof item.command === "string" ? item.command : ""), status, details: completed ? commandOutcome(item) : undefined });
          if (item.type === "fileChange") {
            const count = Array.isArray(item.changes) ? item.changes.length : 0;
            options.onEvent?.({ type: "file_change", id: `file-${itemId}`, title: count ? `Updating ${count} workspace file${count === 1 ? "" : "s"}` : "Updating isolated workspace", status });
          }
          return;
        }
        if (message.method === "turn/completed") {
          const turn = isRecord(params.turn) ? params.turn : {};
          if (turnId && typeof turn.id === "string" && turn.id !== turnId) return;
          const status = typeof turn.status === "string" ? turn.status : "failed";
          const error = isRecord(turn.error) && typeof turn.error.message === "string" ? turn.error.message : undefined;
          settle({ exitCode: status === "completed" ? 0 : 1, output: output.trim(), codexThreadId: threadId, error: error ?? (status === "completed" ? undefined : `Codex turn ${status}`) });
          child.kill("SIGTERM");
        }
      };

      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: RpcMessage;
        try { message = JSON.parse(line) as RpcMessage; } catch { return; }
        if (typeof message.id === "number" && (message.result || message.error)) {
          const waiting = pending.get(message.id);
          if (!waiting) return;
          pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message ?? "Codex App Server request failed"));
          else waiting.resolve(message.result ?? {});
          return;
        }
        if (typeof message.id === "number" && message.method) {
          // A Slack approval is required before a workspace-write turn starts.
          send({ id: message.id, error: { code: -32000, message: "Traceforge does not support in-turn interactive requests" } });
          return;
        }
        if (message.method) onNotification(message);
      });
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      child.on("error", fail);
      child.on("close", (code) => {
        if (settled) return;
        if (timedOut) return settle({ exitCode: code ?? 1, output: output.trim(), codexThreadId: threadId, error: `Codex timed out after ${options.timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}` });
        settle({ exitCode: code ?? 1, output: output.trim(), codexThreadId: threadId, error: stderr.trim() || "Codex App Server stopped before completing the turn" });
      });

      void (async () => {
        try {
          await request("initialize", { clientInfo: { name: "traceforge", title: "Traceforge", version: "0.1.0" } });
          send({ method: "initialized", params: {} });
          const thread = threadId
            ? await request("thread/resume", { threadId, cwd: options.workspacePath, sandbox, approvalPolicy: "never" })
            : await request("thread/start", { cwd: options.workspacePath, sandbox, approvalPolicy: "never", serviceName: "traceforge" });
          const threadRecord = isRecord(thread.thread) ? thread.thread : undefined;
          if (!threadRecord || typeof threadRecord.id !== "string") throw new Error("Codex App Server did not return a thread ID");
          threadId = threadRecord.id;
          await options.onThreadStarted?.(threadId);
          const turn = await request("turn/start", { threadId, input: [{ type: "text", text: options.prompt }], cwd: options.workspacePath, sandboxPolicy, approvalPolicy: "never", outputSchema: options.outputSchema });
          const turnRecord = isRecord(turn.turn) ? turn.turn : undefined;
          turnId = typeof turnRecord?.id === "string" ? turnRecord.id : undefined;
        } catch (error) {
          child.kill("SIGTERM");
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function planStatus(value: unknown): CodexTaskStatus { return value === "completed" ? "complete" : "in_progress"; }
function commandTitle(command: string): string {
  if (/git\s.*\blog\b/i.test(command)) return "Reviewing recent Git history";
  if (/\brg\b|\bgrep\b|\bfind\b/i.test(command)) return "Searching relevant source code";
  if (/\b(test|jest|vitest|gradle|xcodebuild)\b/i.test(command)) return "Checking relevant tests";
  if (/\bgit\s+(diff|status)\b/i.test(command)) return "Reviewing workspace changes";
  return "Inspecting relevant implementation";
}
function commandOutcome(item: Record<string, unknown>): string | undefined {
  if (item.status === "failed") return "Command did not complete";
  return typeof item.durationMs === "number" ? `Completed in ${(item.durationMs / 1_000).toFixed(1)}s` : undefined;
}
