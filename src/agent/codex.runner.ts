import { Codex, type ThreadEvent } from "@openai/codex-sdk";

export interface CodexRunOptions {
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  mode?: "read-only" | "workspace-write";
  allowNetwork?: boolean;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  additionalWritableRoots?: string[];
  threadId?: string;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
  onEvent?: (event: ThreadEvent) => void | Promise<void>;
}

export interface CodexRunResult {
  exitCode: number;
  output: string;
  codexThreadId?: string;
  error?: string;
  timedOut?: boolean;
}

/**
 * Official Codex SDK adapter. The SDK owns the CLI process and JSONL protocol;
 * Traceforge owns durable thread IDs, timeout/cancellation, and safe event delivery.
 */
export class CodexRunner {
  /** Omit the override to use the CLI version bundled with @openai/codex-sdk. */
  constructor(private readonly command?: string) {}

  async run(options: CodexRunOptions): Promise<CodexRunResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Codex timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const abortFromCaller = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abortFromCaller();
    else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const codex = this.command ? new Codex({ codexPathOverride: this.command }) : new Codex();
      const threadOptions = {
        workingDirectory: options.workspacePath,
        sandboxMode: options.mode === "workspace-write" ? "workspace-write" as const : "read-only" as const,
        approvalPolicy: "never" as const,
        networkAccessEnabled: options.allowNetwork ?? false,
        additionalDirectories: options.mode === "workspace-write" ? options.additionalWritableRoots : undefined,
        threadSource: "traceforge",
      };
      const thread = options.threadId ? codex.resumeThread(options.threadId, threadOptions) : codex.startThread(threadOptions);
      let threadId = options.threadId;
      let failure: string | undefined;
      const completedMessages = new Map<string, string>();
      const latestMessages = new Map<string, string>();
      const { events } = await thread.runStreamed(options.prompt, { outputSchema: options.outputSchema, signal: controller.signal });
      const consumeEvents = async (): Promise<void> => {
        for await (const event of events) {
          if (event.type === "thread.started") {
            threadId = event.thread_id;
            await options.onThreadStarted?.(threadId);
          }
          if (event.type === "item.updated" && event.item.type === "agent_message") latestMessages.set(event.item.id, event.item.text);
          if (event.type === "item.completed" && event.item.type === "agent_message") completedMessages.set(event.item.id, event.item.text);
          if (event.type === "turn.failed") failure = event.error.message;
          if (event.type === "error") failure = event.message;
          await options.onEvent?.(event);
        }
      };
      const consumed = consumeEvents().then(() => ({ type: "completed" as const }), (error: unknown) => ({ type: "failed" as const, error }));
      const aborted = controller.signal.aborted
        ? Promise.resolve({ type: "aborted" as const })
        : new Promise<{ type: "aborted" }>((resolve) => controller.signal.addEventListener("abort", () => resolve({ type: "aborted" }), { once: true }));
      const outcome = await Promise.race([consumed, aborted]);
      if (outcome.type === "aborted") {
        const message = controller.signal.reason instanceof Error ? controller.signal.reason.message : "Codex turn interrupted";
        return { exitCode: 1, output: "", codexThreadId: threadId, error: message, timedOut };
      }
      if (outcome.type === "failed") throw outcome.error;

      threadId ??= thread.id ?? undefined;
      const output = [...(completedMessages.size ? completedMessages : latestMessages).values()].join("\n").trim();
      if (failure) return { exitCode: 1, output, codexThreadId: threadId, error: failure };
      return { exitCode: 0, output, codexThreadId: threadId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        const timeoutMessage = controller.signal.reason instanceof Error ? controller.signal.reason.message : undefined;
        return { exitCode: 1, output: "", codexThreadId: options.threadId, error: timeoutMessage ?? message ?? "Codex turn interrupted", timedOut };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}
