import { promises as fs } from "node:fs";
import path from "node:path";
import { ApprovalAction, InvestigationEventType, InvestigationStatus, type InvestigationJob } from "@prisma/client";
import type { Logger } from "pino";
import { CodexRunner } from "../agent/codex.runner.js";
import { buildCodexPrompt } from "../agent/codex.context.js";
import { JiraClient } from "../jira/jira.client.js";
import { normalizeJiraIssue } from "../jira/jira.service.js";
import { SlackFormatter } from "../slack/slack.service.js";
import { CodexToSlackMapper } from "../slack/codex-to-slack.js";
import { SlackStreamingService } from "../slack/slack.streaming.js";
import { InvestigationRepository } from "../storage/repositories/investigation.repository.js";
import { WorkspaceManager } from "../workspace/workspace.manager.js";
import { InvestigationContextBuilder } from "./investigation.context.js";
import { type WriteScope, WriteIntentClassifier } from "./write-intent.js";

class CodexTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "CodexTimeoutError"; }
}

export class InvestigationService {
  private readonly contextBuilder: InvestigationContextBuilder;
  private readonly activeRuns = new Map<string, { controller: AbortController; disposition: "paused" | "cancelled" }>();
  constructor(
    private readonly repository: InvestigationRepository,
    private readonly jira: JiraClient,
    private readonly workspace: WorkspaceManager,
    private readonly codex: CodexRunner,
    private readonly streaming: SlackStreamingService,
    private readonly formatter: SlackFormatter,
    private readonly timeoutMs: number,
    private readonly approvalTimeoutMinutes: number,
    private readonly writeIntent: WriteIntentClassifier,
    private readonly logger: Logger,
  ) { this.contextBuilder = new InvestigationContextBuilder(repository); }

  stop(investigationId: string): boolean {
    const run = this.activeRuns.get(investigationId);
    if (!run) return false;
    run.disposition = "paused";
    run.controller.abort();
    return true;
  }

  dismiss(investigationId: string): boolean {
    const run = this.activeRuns.get(investigationId);
    if (!run) return false;
    run.disposition = "cancelled";
    run.controller.abort();
    return true;
  }

  async process(job: InvestigationJob): Promise<void> {
    let responseTs: string | undefined;
    let controlTs: string | undefined;
    let activeRun: { controller: AbortController; disposition: "paused" | "cancelled" } | undefined;
    try {
      let investigation = await this.repository.getInvestigation(job.investigationId);
      if (!investigation) throw new Error(`Investigation not found: ${job.investigationId}`);
      const staleIssue = normalizeJiraIssue(investigation.jiraIssue.snapshot);
      const fetched = normalizeJiraIssue(await this.jira.getIssue(staleIssue.key));
      await this.repository.updateJiraIssue(investigation.id, fetched);
      investigation = await this.repository.getInvestigation(job.investigationId);
      if (!investigation) throw new Error(`Investigation not found after Jira refresh: ${job.investigationId}`);

      const thread = investigation.slackThread;
      if (!thread) throw new Error("Socket Mode investigation is missing its Slack thread mapping");
      const activeInvestigation = investigation;

      const question = ((job.payload as { question?: unknown }).question as string | undefined) ?? activeInvestigation.currentQuestion;
      const requester = (job.payload as { requester?: { userId?: string; teamId?: string } }).requester;
      const writeApproved = job.type === "APPROVED_WRITE";
      const writeScope = !writeApproved && question ? await this.classifyWriteIntent(question) : "READ_ONLY";
      if (!writeApproved && question && requiresApproval(writeScope)) {
        let approval = await this.repository.getApprovalForJob(job.id);
        if (!approval) {
          approval = await this.repository.createPatchApproval({ investigationId: activeInvestigation.id, jobId: job.id, action: approvalAction(writeScope), question, requestedByUserId: requester?.userId, channelId: thread.channelId, threadTs: thread.threadTs, expiresAt: new Date(Date.now() + this.approvalTimeoutMinutes * 60_000) });
          const message = await this.streaming.postThreadMessage(thread.channelId, thread.threadTs, this.formatter.approval({ issueKey: fetched.key, summary: fetched.summary, approvalId: approval.id, question, expiresAt: approval.expiresAt, scope: writeScope }));
          await this.repository.attachApprovalMessage(approval.id, message.ts);
          await this.repository.addEvent(activeInvestigation.id, InvestigationEventType.AGENT_OUTPUT, "orchestrator", "Awaiting approval for workspace write access", { approvalId: approval.id });
        }
        await this.repository.setStatus(activeInvestigation.id, InvestigationStatus.WAITING_FOR_INPUT);
        await this.repository.completeJob(job.id);
        return;
      }
      await this.repository.setStatus(activeInvestigation.id, InvestigationStatus.PREPARING_WORKSPACE);
      const prepared = await this.workspace.prepare(fetched.key, fetched.summary);
      await this.repository.saveSnapshots(activeInvestigation.id, prepared.snapshots);
      await this.repository.setStatus(activeInvestigation.id, InvestigationStatus.INVESTIGATING, { workspacePath: prepared.rootPath });
      const context = await this.contextBuilder.build(activeInvestigation.id, prepared.rootPath, question ?? null);
      const allowCommit = writeApproved && (job.payload as { allowCommit?: unknown }).allowCommit === true;
      const allowPublish = writeApproved && (job.payload as { allowPublish?: unknown }).allowPublish === true;
      const prompt = buildCodexPrompt(context, writeApproved, allowCommit, allowPublish);
      await this.repository.addEvent(activeInvestigation.id, InvestigationEventType.AGENT_STARTED, "codex", question ?? "Initial investigation");
      const controls = await this.streaming.postThreadMessage(thread.channelId, thread.threadTs, this.formatter.runControls({ investigationId: activeInvestigation.id, issueKey: fetched.key, summary: fetched.summary }));
      controlTs = controls.ts;
      try {
        responseTs = await this.streaming.startResponse(thread.channelId, thread.threadTs, this.formatter.progress(question), requester);
      } catch (error) {
        this.logger.error({ err: error, investigationId: activeInvestigation.id }, "Could not start Slack response stream");
        throw error;
      }
      const codexToSlack = new CodexToSlackMapper(this.streaming, responseTs);
      activeRun = { controller: new AbortController(), disposition: "paused" };
      this.activeRuns.set(activeInvestigation.id, activeRun);
      const result = await this.codex.run({
        workspacePath: prepared.rootPath,
        prompt,
        timeoutMs: this.timeoutMs,
        mode: writeApproved ? "workspace-write" : "read-only",
        allowNetwork: allowPublish,
        additionalWritableRoots: allowCommit ? prepared.snapshots.flatMap((snapshot) => snapshot.gitWritePaths) : undefined,
        signal: activeRun.controller.signal,
        threadId: activeInvestigation.codexThreadId ?? undefined,
        onThreadStarted: async (threadId) => { await this.repository.setCodexThreadId(activeInvestigation.id, threadId); },
        onEvent: (event) => codexToSlack.handle(event),
      });
      if (result.codexThreadId && result.codexThreadId !== activeInvestigation.codexThreadId) await this.repository.setCodexThreadId(activeInvestigation.id, result.codexThreadId);
      if (result.timedOut) throw new CodexTimeoutError(result.error ?? "Codex reached its configured time limit.");
      if (result.exitCode !== 0) throw new Error(result.error ?? `Codex exited with code ${result.exitCode}`);
      const findings = result.output.trim() || "Codex completed without a user-facing response.";
      await this.appendInvestigationMarkdown(prepared.rootPath, fetched.key, fetched.summary, question, findings);
      await this.repository.addEvent(activeInvestigation.id, InvestigationEventType.AGENT_COMPLETED, "codex", findings, { exitCode: result.exitCode });
      await this.repository.addEvent(activeInvestigation.id, InvestigationEventType.FINDING_ADDED, "codex", findings);
      await this.repository.setStatus(activeInvestigation.id, InvestigationStatus.COMPLETED, { summary: findings.slice(0, 1_000), findings, question: null });
      try {
        await this.streaming.finishResponse(responseTs, this.formatter.complete(fetched, findings, prepared.snapshots));
      } catch (error) {
        // Codex has completed successfully; a Slack delivery failure must not mislabel the investigation as failed.
        this.logger.error({ err: error, investigationId: activeInvestigation.id }, "Could not finalize Slack response stream");
      }
      await this.streaming.updateMessage(thread.channelId, controlTs, this.formatter.finishedControls(fetched.key));
      await this.repository.completeJob(job.id);
    } catch (error) {
      if (activeRun?.controller.signal.aborted) {
        const cancelled = activeRun.disposition === "cancelled";
        const status = cancelled ? InvestigationStatus.CANCELLED : InvestigationStatus.PAUSED;
        const investigation = await this.repository.getInvestigation(job.investigationId).catch(() => null);
        const issue = investigation ? normalizeJiraIssue(investigation.jiraIssue.snapshot) : null;
        await this.repository.setStatus(job.investigationId, status).catch(() => undefined);
        await this.repository.addEvent(job.investigationId, InvestigationEventType.AGENT_COMPLETED, "orchestrator", cancelled ? "Investigation dismissed from Slack" : "Investigation paused from Slack").catch(() => undefined);
        await this.repository.completeJob(job.id).catch(() => undefined);
        if (responseTs) await this.streaming.finishResponse(responseTs, cancelled ? this.formatter.dismissed(issue?.key ?? "Investigation") : this.formatter.pausedControls({ investigationId: job.investigationId, issueKey: issue?.key ?? "Investigation" })).catch(() => undefined);
        if (controlTs && investigation?.slackThread) await this.streaming.updateMessage(investigation.slackThread.channelId, controlTs, cancelled ? this.formatter.dismissed(issue?.key ?? "Investigation") : this.formatter.pausedControls({ investigationId: job.investigationId, issueKey: issue?.key ?? "Investigation" })).catch(() => undefined);
        return;
      }
      if (error instanceof CodexTimeoutError) {
        const investigation = await this.repository.getInvestigation(job.investigationId).catch(() => null);
        const issueKey = investigation ? normalizeJiraIssue(investigation.jiraIssue.snapshot).key : "Investigation";
        const paused = this.formatter.pausedControls({ investigationId: job.investigationId, issueKey, reason: "Codex reached its configured time limit. Continue resumes this investigation from its saved context." });
        await this.repository.setStatus(job.investigationId, InvestigationStatus.PAUSED).catch(() => undefined);
        await this.repository.addEvent(job.investigationId, InvestigationEventType.AGENT_COMPLETED, "orchestrator", "Investigation paused because Codex reached its configured time limit", { timeoutMs: this.timeoutMs }).catch(() => undefined);
        await this.repository.completeJob(job.id).catch(() => undefined);
        if (responseTs) await this.streaming.finishResponse(responseTs, paused).catch(() => undefined);
        if (controlTs && investigation?.slackThread) await this.streaming.updateMessage(investigation.slackThread.channelId, controlTs, paused).catch(() => undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, jobId: job.id }, "Investigation job failed");
      await this.repository.addEvent(job.investigationId, InvestigationEventType.AGENT_ERROR, "orchestrator", message).catch(() => undefined);
      await this.repository.setStatus(job.investigationId, InvestigationStatus.FAILED).catch(() => undefined);
      await this.repository.failJob(job.id, message).catch(() => undefined);
      if (responseTs) await this.streaming.sendError(responseTs, this.formatter.error(message)).catch((slackError) => this.logger.error({ err: slackError, jobId: job.id }, "Could not finalize Slack error response"));
    } finally {
      if (activeRun && this.activeRuns.get(job.investigationId) === activeRun) this.activeRuns.delete(job.investigationId);
    }
  }

  private async appendInvestigationMarkdown(workspacePath: string, issueKey: string, summary: string, question: string | null, findings: string): Promise<void> {
    const file = path.join(workspacePath, "investigation.md");
    const heading = question ? "Slack / follow-up question" : "Initial investigation";
    try { await fs.access(file); } catch { await fs.writeFile(file, `# ${issueKey} Investigation\n\n## Jira\n\n${summary}\n`, "utf8"); }
    await fs.appendFile(file, `\n## ${heading} — ${new Date().toISOString()}\n\n${question ? `Question: ${question}\n\n` : ""}${findings}\n`, "utf8");
  }

  private async classifyWriteIntent(question: string): Promise<WriteScope> {
    try { return await this.writeIntent.classify(question); }
    catch (error) { this.logger.warn({ err: error }, "Could not classify Slack authorization intent; keeping the request read-only"); return "UNCERTAIN"; }
  }
}

function requiresApproval(scope: WriteScope): scope is "PATCH" | "COMMIT" | "PUSH" { return scope !== "READ_ONLY" && scope !== "UNCERTAIN"; }
function approvalAction(scope: "PATCH" | "COMMIT" | "PUSH"): ApprovalAction { return scope === "PUSH" ? ApprovalAction.CREATE_AND_PUSH : scope === "COMMIT" ? ApprovalAction.CREATE_AND_COMMIT : ApprovalAction.CREATE_PATCH; }
