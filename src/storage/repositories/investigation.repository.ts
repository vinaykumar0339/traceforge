import { ApprovalAction, ApprovalStatus, InvestigationEventType, InvestigationStatus, JobStatus, Prisma, PrismaClient } from "@prisma/client";
import type { NormalizedJiraIssue } from "../../jira/jira.types.js";
import type { WorkspaceSnapshot } from "../../workspace/workspace.manager.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class InvestigationRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Returns the investigation that owns a Slack thread, without consuming the event. */
  async findInvestigationIdForSlackThread(channelId: string, threadTs: string): Promise<string | null> {
    const thread = await this.db.slackThread.findUnique({ where: { channelId_threadTs: { channelId, threadTs } }, select: { investigationId: true } });
    return thread?.investigationId ?? null;
  }

  /** Starts an investigation from a Slack Socket Mode command after Jira has been fetched. */
  async startSlackInvestigation(input: { eventId: string; channelId: string; threadTs: string; issue: NormalizedJiraIssue; question: string; requester: { userId: string; teamId: string } }): Promise<string | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.externalEvent.create({ data: { source: "slack-socket", providerEventId: input.eventId } });
        const jira = await tx.jiraIssue.upsert({
          where: { jiraIssueId: input.issue.id },
          create: { jiraIssueId: input.issue.id, issueKey: input.issue.key, snapshot: json(input.issue) },
          update: { issueKey: input.issue.key, snapshot: json(input.issue), fetchedAt: new Date() },
        });
        const investigation = await tx.investigation.upsert({
          where: { jiraIssueRecordId: jira.id },
          create: { jiraIssueRecordId: jira.id, currentQuestion: input.question },
          update: { currentQuestion: input.question, status: InvestigationStatus.CREATED },
        });
        await tx.slackThread.upsert({
          where: { investigationId: investigation.id },
          create: { investigationId: investigation.id, channelId: input.channelId, threadTs: input.threadTs },
          update: { channelId: input.channelId, threadTs: input.threadTs },
        });
        await tx.investigationEvent.create({ data: {
          investigationId: investigation.id,
          type: InvestigationEventType.SLACK_MESSAGE,
          source: "slack-socket",
          content: input.question,
          metadata: json({ eventId: input.eventId, channelId: input.channelId, threadTs: input.threadTs, issueKey: input.issue.key }),
        } });
        await tx.investigationJob.create({ data: {
          investigationId: investigation.id,
          type: "SLACK_TRIGGER",
          payload: json({ question: input.question, requester: input.requester }),
          dedupeKey: `slack-socket:${input.eventId}`,
        } });
        return investigation.id;
      });
    } catch (error) {
      if (isUniqueError(error)) return null;
      throw error;
    }
  }

  /** Queues a Socket Mode app mention made in a stored investigation thread. */
  async enqueueSocketQuestion(input: { eventId: string; channelId: string; threadTs: string; question: string; requester: { userId: string; teamId: string } }): Promise<string | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.externalEvent.create({ data: { source: "slack-socket", providerEventId: input.eventId } });
        const thread = await tx.slackThread.findUnique({ where: { channelId_threadTs: { channelId: input.channelId, threadTs: input.threadTs } } });
        if (!thread) return null;
        await tx.investigation.update({ where: { id: thread.investigationId }, data: { currentQuestion: input.question } });
        await tx.investigationEvent.create({ data: { investigationId: thread.investigationId, type: InvestigationEventType.USER_QUESTION, source: "slack-socket", content: input.question, metadata: json({ eventId: input.eventId, channelId: input.channelId, threadTs: input.threadTs }) } });
        await tx.investigationJob.create({ data: { investigationId: thread.investigationId, type: "SLACK_QUESTION", payload: json({ question: input.question, requester: input.requester }), dedupeKey: `slack-socket:${input.eventId}` } });
        return thread.investigationId;
      });
    } catch (error) {
      if (isUniqueError(error)) return null;
      throw error;
    }
  }

  async enqueueApiQuestion(investigationId: string, question: string): Promise<void> {
    const id = crypto.randomUUID();
    await this.db.$transaction(async (tx) => {
      await tx.investigation.update({ where: { id: investigationId }, data: { currentQuestion: question } });
      await tx.investigationEvent.create({ data: { investigationId, type: InvestigationEventType.USER_QUESTION, source: "api", content: question } });
      await tx.investigationJob.create({ data: { investigationId, type: "API_QUESTION", payload: json({ question }), dedupeKey: `api:${id}` } });
    });
  }

  async continueInvestigation(investigationId: string, interactionId: string, requester: { userId: string; teamId: string }): Promise<boolean> {
    try {
      await this.db.$transaction(async (tx) => {
        const investigation = await tx.investigation.findUnique({ where: { id: investigationId } });
        if (!investigation || investigation.status === InvestigationStatus.CANCELLED) throw new Error("Investigation cannot be continued");
        const question = investigation.currentQuestion ?? "Continue the paused investigation from the saved context.";
        await tx.investigation.update({ where: { id: investigationId }, data: { status: InvestigationStatus.CREATED } });
        await tx.investigationEvent.create({ data: { investigationId, type: InvestigationEventType.USER_QUESTION, source: "slack", content: "Continue requested", metadata: json({ interactionId }) } });
        await tx.investigationJob.create({ data: { investigationId, type: "SLACK_CONTINUE", payload: json({ question, requester }), dedupeKey: `continue:${interactionId}` } });
      });
      return true;
    } catch (error) {
      if (isUniqueError(error)) return false;
      throw error;
    }
  }

  async dismissInvestigation(investigationId: string, interactionId: string): Promise<boolean> {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.externalEvent.create({ data: { source: "slack-control", providerEventId: interactionId } });
        await tx.investigation.update({ where: { id: investigationId }, data: { status: InvestigationStatus.CANCELLED } });
        await tx.investigationJob.updateMany({ where: { investigationId, status: JobStatus.PENDING }, data: { status: JobStatus.CANCELLED, completedAt: new Date(), error: "Dismissed from Slack" } });
        await tx.investigationEvent.create({ data: { investigationId, type: InvestigationEventType.AGENT_COMPLETED, source: "slack", content: "Investigation dismissed" } });
      });
      return true;
    } catch (error) {
      if (isUniqueError(error)) return false;
      throw error;
    }
  }

  async updateJiraIssue(investigationId: string, issue: NormalizedJiraIssue): Promise<void> {
    const investigation = await this.db.investigation.findUniqueOrThrow({ where: { id: investigationId } });
    await this.db.jiraIssue.update({ where: { id: investigation.jiraIssueRecordId }, data: { snapshot: json(issue), fetchedAt: new Date() } });
  }

  async getInvestigation(id: string) {
    return this.db.investigation.findUnique({
      where: { id },
      include: { jiraIssue: true, slackThread: true, repositorySnapshots: true, events: { orderBy: { createdAt: "asc" }, take: 100 } },
    });
  }

  async getJob(id: string) {
    return this.db.investigationJob.findUnique({ where: { id } });
  }

  async claimNextJob(excludedInvestigationIds: Set<string>) {
    const candidates = await this.db.investigationJob.findMany({ where: { status: JobStatus.PENDING }, orderBy: { createdAt: "asc" }, take: 20 });
    for (const candidate of candidates) {
      if (excludedInvestigationIds.has(candidate.investigationId)) continue;
      const claimed = await this.db.investigationJob.updateMany({ where: { id: candidate.id, status: JobStatus.PENDING }, data: { status: JobStatus.RUNNING, startedAt: new Date(), attempts: { increment: 1 } } });
      if (claimed.count === 1) return this.getJob(candidate.id);
    }
    return null;
  }

  async requeueRunningJobs(): Promise<number> {
    const result = await this.db.investigationJob.updateMany({ where: { status: JobStatus.RUNNING }, data: { status: JobStatus.PENDING, startedAt: null, error: "Requeued after service restart" } });
    return result.count;
  }

  async setStatus(id: string, status: InvestigationStatus, data: { workspacePath?: string; summary?: string; findings?: unknown; question?: string | null } = {}): Promise<void> {
    await this.db.investigation.update({ where: { id }, data: {
      status, workspacePath: data.workspacePath, latestSummary: data.summary,
      latestFindings: data.findings === undefined ? undefined : json(data.findings), currentQuestion: data.question,
    } });
  }

  async setCodexThreadId(id: string, codexThreadId: string): Promise<void> {
    await this.db.investigation.update({ where: { id }, data: { codexThreadId } });
  }

  async addEvent(investigationId: string, type: InvestigationEventType, source: string, content: string, metadata?: unknown): Promise<void> {
    await this.db.investigationEvent.create({ data: { investigationId, type, source, content, metadata: metadata === undefined ? undefined : json(metadata) } });
  }

  async saveSnapshots(investigationId: string, snapshots: WorkspaceSnapshot[]): Promise<void> {
    await this.db.$transaction(snapshots.map((snapshot) => this.db.repositorySnapshot.upsert({
      where: { investigationId_repositoryName: { investigationId, repositoryName: snapshot.repositoryName } },
      create: { investigationId, repositoryName: snapshot.repositoryName, platform: snapshot.platform, sourcePath: snapshot.sourcePath, workspacePath: snapshot.workspacePath, branch: snapshot.branch, commitSha: snapshot.commitSha, sourceUrlTemplate: snapshot.sourceUrlTemplate },
      update: { platform: snapshot.platform, sourcePath: snapshot.sourcePath, workspacePath: snapshot.workspacePath, branch: snapshot.branch, commitSha: snapshot.commitSha, sourceUrlTemplate: snapshot.sourceUrlTemplate, lastUpdatedAt: new Date() },
    })));
  }

  async completeJob(id: string): Promise<void> {
    await this.db.investigationJob.update({ where: { id }, data: { status: JobStatus.COMPLETED, completedAt: new Date(), error: null } });
  }

  async failJob(id: string, error: string): Promise<void> {
    await this.db.investigationJob.update({ where: { id }, data: { status: JobStatus.FAILED, completedAt: new Date(), error } });
  }

  async createPatchApproval(input: { investigationId: string; jobId: string; action: ApprovalAction; question: string; requestedByUserId?: string; channelId: string; threadTs: string; expiresAt: Date }) {
    return this.db.approvalRequest.create({ data: { investigationId: input.investigationId, jobId: input.jobId, action: input.action, question: input.question, requestedByUserId: input.requestedByUserId, slackChannelId: input.channelId, slackThreadTs: input.threadTs, expiresAt: input.expiresAt } });
  }

  async attachApprovalMessage(approvalId: string, messageTs: string): Promise<void> {
    await this.db.approvalRequest.update({ where: { id: approvalId }, data: { slackMessageTs: messageTs } });
  }

  async getApprovalForJob(jobId: string) { return this.db.approvalRequest.findUnique({ where: { jobId } }); }

  async decideApproval(approvalId: string, userId: string, approved: boolean) {
    return this.db.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.findUnique({ where: { id: approvalId } });
      if (!approval) return null;
      if (approval.status !== ApprovalStatus.PENDING) return { approval, changed: false };
      if (approval.expiresAt <= new Date()) {
        const expired = await tx.approvalRequest.update({ where: { id: approval.id }, data: { status: ApprovalStatus.EXPIRED, decisionAt: new Date(), approvedByUserId: userId } });
        return { approval: expired, changed: true };
      }
      const status = approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;
      const decided = await tx.approvalRequest.update({ where: { id: approval.id }, data: { status, approvedByUserId: userId, decisionAt: new Date() } });
      if (approved) await tx.investigationJob.create({ data: { investigationId: approval.investigationId, type: "APPROVED_WRITE", payload: json({ question: approval.question, approvalId: approval.id, allowCommit: approval.action === ApprovalAction.CREATE_AND_COMMIT || approval.action === ApprovalAction.CREATE_AND_PUSH, allowPublish: approval.action === ApprovalAction.CREATE_AND_PUSH }), dedupeKey: `approval:${approval.id}` } });
      return { approval: decided, changed: true };
    });
  }
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
