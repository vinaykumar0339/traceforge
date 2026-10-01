import { createHash } from "node:crypto";
import { Router } from "express";
import type { AppConfig } from "../config/env.js";
import { normalizeJiraIssue } from "../jira/jira.service.js";
import { parseJiraWebhook, verifyJiraSignature } from "../jira/jira.webhook.js";
import type { InvestigationQueue } from "../investigation/investigation.queue.js";
import type { InvestigationRepository } from "../storage/repositories/investigation.repository.js";

type RawRequest = { rawBody?: Buffer };

export function jiraRoutes(config: AppConfig, repository: InvestigationRepository, queue: InvestigationQueue): Router {
  const router = Router();
  router.post("/webhooks/jira", async (request, response, next) => {
    try {
      const raw = (request as typeof request & RawRequest).rawBody ?? Buffer.alloc(0);
      if (!verifyJiraSignature(raw, request.header("x-hub-signature"), config.JIRA_WEBHOOK_SECRET)) return response.status(401).json({ error: "Invalid Jira signature" });
      const webhook = parseJiraWebhook(request.body);
      if (!webhook) return response.status(200).json({ ignored: true });
      const eventId = request.header("x-atlassian-webhook-identifier") ?? createHash("sha256").update(raw).digest("hex");
      const issue = normalizeJiraIssue({ id: webhook.issue.id, key: webhook.issue.key, fields: webhook.issue.fields ?? {} });
      const comment = webhook.comment?.body === undefined ? undefined : typeof webhook.comment.body === "string" ? webhook.comment.body : JSON.stringify(webhook.comment.body);
      const investigationId = await repository.ingestJiraEvent(eventId, webhook.webhookEvent, issue, comment);
      if (investigationId) queue.kick();
      return response.status(200).json({ accepted: Boolean(investigationId), investigationId });
    } catch (error) { next(error); }
  });
  return router;
}
