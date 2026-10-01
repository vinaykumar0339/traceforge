import { Router } from "express";
import type { AppConfig } from "../config/env.js";
import type { InvestigationQueue } from "../investigation/investigation.queue.js";
import { parseSlackEnvelope, verifySlackSignature } from "../slack/slack.events.js";
import { parseSlackInteraction } from "../slack/slack.events.js";
import type { SlackStreamingService } from "../slack/slack.streaming.js";
import { SlackFormatter } from "../slack/slack.service.js";
import type { InvestigationRepository } from "../storage/repositories/investigation.repository.js";
import type { InvestigationService } from "../investigation/investigation.service.js";

type RawRequest = { rawBody?: Buffer };

export function slackRoutes(config: AppConfig, repository: InvestigationRepository, queue: InvestigationQueue, streaming: SlackStreamingService, formatter: SlackFormatter, service: InvestigationService): Router {
  const router = Router();
  router.post("/webhooks/slack", async (request, response, next) => {
    try {
      const raw = (request as typeof request & RawRequest).rawBody ?? Buffer.alloc(0);
      if (!verifySlackSignature(raw, request.header("x-slack-request-timestamp"), request.header("x-slack-signature"), config.SLACK_SIGNING_SECRET)) return response.status(401).json({ error: "Invalid Slack signature" });
      const parsed = parseSlackEnvelope(request.body);
      if (parsed.challenge) return response.status(200).json({ challenge: parsed.challenge });
      if (!parsed.message) return response.status(200).json({ ignored: true });
      const investigationId = await repository.enqueueSlackQuestion(parsed.message.eventId, parsed.message.channelId, parsed.message.threadTs, parsed.message.text, { userId: parsed.message.userId, teamId: parsed.message.teamId });
      if (investigationId) queue.kick();
      return response.status(200).json({ accepted: Boolean(investigationId) });
    } catch (error) { next(error); }
  });
  router.post("/webhooks/slack/interactions", async (request, response, next) => {
    try {
      const raw = (request as typeof request & RawRequest).rawBody ?? Buffer.alloc(0);
      if (!verifySlackSignature(raw, request.header("x-slack-request-timestamp"), request.header("x-slack-signature"), config.SLACK_SIGNING_SECRET)) return response.status(401).json({ error: "Invalid Slack signature" });
      const source = request.body as { payload?: unknown };
      const payload = typeof source.payload === "string" ? JSON.parse(source.payload) : source.payload;
      const interaction = parseSlackInteraction(payload);
      if (!interaction) return response.status(200).json({ ignored: true });
      if (!config.SLACK_APPROVER_USER_IDS.includes(interaction.userId)) return response.status(403).json({ error: "Not authorized to approve investigations" });
      if (interaction.kind === "control") {
        const investigation = await repository.getInvestigation(interaction.investigationId);
        if (!investigation) return response.status(404).json({ error: "Investigation not found" });
        const issueKey = investigation.jiraIssue.issueKey;
        if (interaction.action === "stop") {
          const stopped = service.stop(interaction.investigationId);
          if (stopped) await streaming.updateMessage(interaction.channelId, interaction.messageTs, formatter.stopping(issueKey));
          return response.status(200).json({ ok: true, stopped });
        }
        if (interaction.action === "continue") {
          const queued = await repository.continueInvestigation(interaction.investigationId, interaction.interactionId, { userId: interaction.userId, teamId: interaction.teamId });
          if (queued) { await streaming.updateMessage(interaction.channelId, interaction.messageTs, formatter.resuming(issueKey)); queue.kick(); }
          return response.status(200).json({ ok: true, queued });
        }
        const dismissed = await repository.dismissInvestigation(interaction.investigationId, interaction.interactionId);
        service.dismiss(interaction.investigationId);
        if (dismissed) await streaming.updateMessage(interaction.channelId, interaction.messageTs, formatter.dismissed(issueKey));
        return response.status(200).json({ ok: true, dismissed });
      }
      const decided = await repository.decideApproval(interaction.approvalId, interaction.userId, interaction.decision === "approve");
      if (!decided) return response.status(404).json({ error: "Approval not found" });
      if (decided.changed) {
        const approved = decided.approval.status === "APPROVED";
        await streaming.updateMessage(interaction.channelId, interaction.messageTs, formatter.approvalDecided(approved, interaction.userId));
        if (approved) queue.kick();
      }
      return response.status(200).json({ ok: true });
    } catch (error) { next(error); }
  });
  return router;
}
