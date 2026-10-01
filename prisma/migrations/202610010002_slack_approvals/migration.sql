CREATE TYPE "ApprovalAction" AS ENUM ('CREATE_PATCH');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "ApprovalRequest" (
  "id" TEXT NOT NULL,
  "investigationId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "action" "ApprovalAction" NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "question" TEXT NOT NULL,
  "requestedByUserId" TEXT,
  "approvedByUserId" TEXT,
  "decisionAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "slackChannelId" TEXT NOT NULL,
  "slackThreadTs" TEXT NOT NULL,
  "slackMessageTs" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApprovalRequest_jobId_key" ON "ApprovalRequest"("jobId");
CREATE INDEX "ApprovalRequest_investigationId_status_idx" ON "ApprovalRequest"("investigationId", "status");
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "InvestigationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
