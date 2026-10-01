-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "InvestigationStatus" AS ENUM ('CREATED', 'PREPARING_WORKSPACE', 'INVESTIGATING', 'WAITING_FOR_INPUT', 'COMPLETED', 'FAILED');
CREATE TYPE "InvestigationEventType" AS ENUM ('JIRA_CREATED', 'JIRA_UPDATED', 'USER_QUESTION', 'AGENT_STARTED', 'AGENT_OUTPUT', 'AGENT_COMPLETED', 'AGENT_ERROR', 'SLACK_MESSAGE', 'FINDING_ADDED');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "JiraIssue" (
  "id" TEXT NOT NULL, "jiraIssueId" TEXT NOT NULL, "issueKey" TEXT NOT NULL, "snapshot" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "JiraIssue_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Investigation" (
  "id" TEXT NOT NULL, "jiraIssueRecordId" TEXT NOT NULL, "status" "InvestigationStatus" NOT NULL DEFAULT 'CREATED',
  "currentQuestion" TEXT, "workspacePath" TEXT, "latestSummary" TEXT, "latestFindings" JSONB, "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InvestigationEvent" (
  "id" TEXT NOT NULL, "investigationId" TEXT NOT NULL, "type" "InvestigationEventType" NOT NULL, "source" TEXT NOT NULL,
  "content" TEXT NOT NULL, "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvestigationEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SlackThread" (
  "id" TEXT NOT NULL, "channelId" TEXT NOT NULL, "threadTs" TEXT NOT NULL, "investigationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlackThread_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RepositorySnapshot" (
  "id" TEXT NOT NULL, "investigationId" TEXT NOT NULL, "repositoryName" TEXT NOT NULL, "platform" TEXT,
  "sourcePath" TEXT NOT NULL, "workspacePath" TEXT NOT NULL, "branch" TEXT NOT NULL, "commitSha" TEXT NOT NULL,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "RepositorySnapshot_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExternalEvent" (
  "id" TEXT NOT NULL, "source" TEXT NOT NULL, "providerEventId" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ExternalEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "InvestigationJob" (
  "id" TEXT NOT NULL, "investigationId" TEXT NOT NULL, "type" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "dedupeKey" TEXT NOT NULL, "status" "JobStatus" NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT, "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "InvestigationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JiraIssue_jiraIssueId_key" ON "JiraIssue"("jiraIssueId");
CREATE UNIQUE INDEX "JiraIssue_issueKey_key" ON "JiraIssue"("issueKey");
CREATE UNIQUE INDEX "Investigation_jiraIssueRecordId_key" ON "Investigation"("jiraIssueRecordId");
CREATE INDEX "InvestigationEvent_investigationId_createdAt_idx" ON "InvestigationEvent"("investigationId", "createdAt");
CREATE UNIQUE INDEX "SlackThread_investigationId_key" ON "SlackThread"("investigationId");
CREATE UNIQUE INDEX "SlackThread_channelId_threadTs_key" ON "SlackThread"("channelId", "threadTs");
CREATE UNIQUE INDEX "RepositorySnapshot_investigationId_repositoryName_key" ON "RepositorySnapshot"("investigationId", "repositoryName");
CREATE UNIQUE INDEX "ExternalEvent_source_providerEventId_key" ON "ExternalEvent"("source", "providerEventId");
CREATE UNIQUE INDEX "InvestigationJob_dedupeKey_key" ON "InvestigationJob"("dedupeKey");
CREATE INDEX "InvestigationJob_status_createdAt_idx" ON "InvestigationJob"("status", "createdAt");
CREATE INDEX "InvestigationJob_investigationId_status_createdAt_idx" ON "InvestigationJob"("investigationId", "status", "createdAt");

ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_jiraIssueRecordId_fkey" FOREIGN KEY ("jiraIssueRecordId") REFERENCES "JiraIssue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvestigationEvent" ADD CONSTRAINT "InvestigationEvent_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SlackThread" ADD CONSTRAINT "SlackThread_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestigationJob" ADD CONSTRAINT "InvestigationJob_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
