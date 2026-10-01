import { promises as fs } from "node:fs";
import path from "node:path";
import { ApprovalAction, InvestigationEventType, InvestigationStatus, type InvestigationJob } from "@prisma/client";
import type { Logger } from "pino";
import { CodexRunner } from "../agent/codex.runner.js";
import { buildCodexPrompt } from "../agent/codex.context.js";
import { codexOutputToText } from "../agent/codex.parser.js";
import { JiraClient } from "../jira/jira.client.js";
import { normalizeJiraIssue } from "../jira/jira.service.js";
import { SlackFormatter } from "../slack/slack.service.js";
import { SlackStreamingService } from "../slack/slack.streaming.js";
import { InvestigationRepository } from "../storage/repositories/investigation.repository.js";
import { WorkspaceManager } from "../workspace/workspace.manager.js";
import { InvestigationContextBuilder } from "./investigation.context.js";
import { type WriteScope, WriteIntentClassifier } from "./write-intent.js";

export class InvestigationService {
  private readonly contextBuilder: InvestigationContextBuilder;
  constructor(
    private readonly repository: InvestigationRepository,
    private readonly jira: JiraClient,
    private readonly workspace: WorkspaceManager,
    private readonly codex: CodexRunner,
    private readonly streaming: SlackStreamingService,
    private readonly formatter: SlackFormatter,
    private readonly timeoutMs: number,
    private readonly slackChannelId: string,
    private readonly approvalTimeoutMinutes: number,
    private readonly writeIntent: WriteIntentClassifier,
    private readonly logger: Logger,
  ) { this.contextBuilder = new InvestigationContextBuilder(repository); }

  async process(job: InvestigationJob): Promise<void> {
    let responseTs: string | undefined;
    try {
      let investigation = await this.repository.getInvestigation(job.investigationId);
      if (!investigation) throw new Error(`Investigation not found: ${job.investigationId}`);
      const staleIssue = normalizeJiraIssue(investigation.jiraIssue.snapshot);
      const fetched = normalizeJiraIssue(await this.jira.getIssue(staleIssue.key));
      await this.repository.updateJiraIssue(investigation.id, fetched);
      investigation = await this.repository.getInvestigation(job.investigationId);
      if (!investigation) throw new Error(`Investigation not found after Jira refresh: ${job.investigationId}`);

      let thread = investigation.slackThread;
      if (!thread) {
        // Slack owns the root message; persistence owns its stable mapping.
        const root = await this.streaming.postRootMessage(this.slackChannelId, this.formatter.initial(fetched));
        await this.repository.ensureSlackThread(investigation.id, this.slackChannelId, root.ts);
        investigation = await this.repository.getInvestigation(job.investigationId);
        thread = investigation?.slackThread ?? null;
      }
      if (!investigation || !thread) throw new Error("Could not establish Slack investigation thread");
      const activeInvestigation = investigation;

      const question = job.type === "JIRA_SYNC" ? null : ((job.payload as { question?: unknown }).question as string | undefined) ?? activeInvestigation.currentQuestion;
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
      responseTs = await this.streaming.startResponse(thread.channelId, thread.threadTs, this.formatter.progress(question), requester);
      const result = await this.codex.run({
        workspacePath: prepared.rootPath,
        prompt,
        timeoutMs: this.timeoutMs,
        mode: writeApproved ? "workspace-write" : "read-only",
        allowNetwork: allowPublish,
        threadId: activeInvestigation.codexThreadId ?? undefined,
        onThreadStarted: async (threadId) => { await this.repository.setCodexThreadId(activeInvestigation.id, threadId); },
        onEvent: (event) => {
          if (event.type === "message") this.streaming.appendResponse(responseTs!, event.text);
          else if (event.type === "plan") this.streaming.setPlan(responseTs!, event.title, event.steps);
          else if (event.type === "task" || event.type === "file_change") this.streaming.updateTask(responseTs!, event);
        },
      });
      if (result.exitCode !== 0) throw new Error(result.error ?? `Codex exited with code ${result.exitCode}`);
      if (result.codexThreadId && result.codexThreadId !== activeInvestigation.codexThreadId) await this.repository.setCodexThreadId(activeInvestigation.id, result.codexThreadId);
      const findings = codexOutputToText(result.output);
      await this.appendInvestigationMarkdown(prepared.rootPath, fetched.key, fetched.summary, question, findings);
      await this.repository.addEvent(activeInvestigation.id, InvestigationEventType.AGENT_COMPLETED, "codex", findings, { exitCode: result.exitCode });
      await this.repository.addEvent(activeInvestigation.id, InvestigationEventType.FINDING_ADDED, "codex", findings);
      await this.repository.setStatus(activeInvestigation.id, InvestigationStatus.COMPLETED, { summary: findings.slice(0, 1_000), findings, question: null });
      await this.streaming.finishResponse(responseTs, this.formatter.complete(fetched, findings, prepared.snapshots));
      await this.repository.completeJob(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, jobId: job.id }, "Investigation job failed");
      await this.repository.addEvent(job.investigationId, InvestigationEventType.AGENT_ERROR, "orchestrator", message).catch(() => undefined);
      await this.repository.setStatus(job.investigationId, InvestigationStatus.FAILED).catch(() => undefined);
      await this.repository.failJob(job.id, message).catch(() => undefined);
      if (responseTs) await this.streaming.sendError(responseTs, this.formatter.error(message)).catch(() => undefined);
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
