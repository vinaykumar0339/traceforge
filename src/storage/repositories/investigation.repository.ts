import { ApprovalAction, ApprovalStatus, InvestigationEventType, InvestigationStatus, JobStatus, Prisma, PrismaClient } from "@prisma/client";
import type { NormalizedJiraIssue } from "../../jira/jira.types.js";
import type { WorkspaceSnapshot } from "../../workspace/workspace.manager.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export interface InvestigationContextRecord {
  investigation: Awaited<ReturnType<InvestigationRepository["getInvestigation"]>>;
  jira: NormalizedJiraIssue;
}

export class InvestigationRepository {
  constructor(private readonly db: PrismaClient) {}

  async ingestJiraEvent(eventId: string, eventType: string, issue: NormalizedJiraIssue, comment?: string): Promise<string | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.externalEvent.create({ data: { source: "jira", providerEventId: eventId } });
        const jira = await tx.jiraIssue.upsert({
          where: { jiraIssueId: issue.id },
          create: { jiraIssueId: issue.id, issueKey: issue.key, snapshot: json(issue) },
          update: { issueKey: issue.key, snapshot: json(issue), fetchedAt: new Date() },
        });
        const investigation = await tx.investigation.upsert({
          where: { jiraIssueRecordId: jira.id },
          create: { jiraIssueRecordId: jira.id },
          update: {},
        });
        await tx.investigationEvent.create({ data: {
          investigationId: investigation.id,
          type: eventType === "jira:issue_created" ? InvestigationEventType.JIRA_CREATED : InvestigationEventType.JIRA_UPDATED,
          source: "jira", content: `${issue.key}: ${issue.summary}`, metadata: json({ eventId, eventType }),
        } });
        await tx.investigationJob.create({ data: {
          investigationId: investigation.id, type: comment ? "JIRA_COMMENT" : "JIRA_SYNC", payload: json(comment ? { issueKey: issue.key, question: comment } : { issueKey: issue.key }), dedupeKey: `jira:${eventId}`,
        } });
        return investigation.id;
      });
    } catch (error) {
      if (isUniqueError(error)) return null;
      throw error;
    }
  }

  async enqueueSlackQuestion(eventId: string, channelId: string, threadTs: string, question: string, requester: { userId: string; teamId: string }): Promise<string | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.externalEvent.create({ data: { source: "slack", providerEventId: eventId } });
        const thread = await tx.slackThread.findUnique({ where: { channelId_threadTs: { channelId, threadTs } } });
        if (!thread) return null;
        await tx.investigation.update({ where: { id: thread.investigationId }, data: { currentQuestion: question } });
        await tx.investigationEvent.create({ data: { investigationId: thread.investigationId, type: InvestigationEventType.USER_QUESTION, source: "slack", content: question, metadata: json({ eventId, channelId, threadTs }) } });
        await tx.investigationJob.create({ data: { investigationId: thread.investigationId, type: "SLACK_QUESTION", payload: json({ question, requester }), dedupeKey: `slack:${eventId}` } });
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
      create: { investigationId, repositoryName: snapshot.repositoryName, platform: snapshot.platform, sourcePath: snapshot.sourcePath, workspacePath: snapshot.workspacePath, branch: snapshot.branch, commitSha: snapshot.commitSha },
      update: { platform: snapshot.platform, sourcePath: snapshot.sourcePath, workspacePath: snapshot.workspacePath, branch: snapshot.branch, commitSha: snapshot.commitSha, lastUpdatedAt: new Date() },
    })));
  }

  async ensureSlackThread(investigationId: string, channelId: string, threadTs: string): Promise<void> {
    await this.db.slackThread.upsert({ where: { investigationId }, create: { investigationId, channelId, threadTs }, update: { channelId, threadTs } });
  }

  async completeJob(id: string): Promise<void> {
    await this.db.investigationJob.update({ where: { id }, data: { status: JobStatus.COMPLETED, completedAt: new Date(), error: null } });
  }

  async failJob(id: string, error: string): Promise<void> {
    await this.db.investigationJob.update({ where: { id }, data: { status: JobStatus.FAILED, completedAt: new Date(), error } });
  }

  async createPatchApproval(input: { investigationId: string; jobId: string; question: string; requestedByUserId?: string; channelId: string; threadTs: string; expiresAt: Date }) {
    return this.db.approvalRequest.create({ data: { investigationId: input.investigationId, jobId: input.jobId, action: ApprovalAction.CREATE_PATCH, question: input.question, requestedByUserId: input.requestedByUserId, slackChannelId: input.channelId, slackThreadTs: input.threadTs, expiresAt: input.expiresAt } });
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
      if (approved) await tx.investigationJob.create({ data: { investigationId: approval.investigationId, type: "APPROVED_WRITE", payload: json({ question: approval.question, approvalId: approval.id }), dedupeKey: `approval:${approval.id}` } });
      return { approval: decided, changed: true };
    });
  }
}

function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
