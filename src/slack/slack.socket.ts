import { SocketModeClient } from "@slack/socket-mode";
import { ApprovalStatus } from "@prisma/client";
import type { Logger } from "pino";
import type { AppConfig } from "../config/env.js";
import { type JiraClient } from "../jira/jira.client.js";
import { normalizeJiraIssue } from "../jira/jira.service.js";
import type { InvestigationQueue } from "../investigation/investigation.queue.js";
import type { InvestigationService } from "../investigation/investigation.service.js";
import type { InvestigationRepository } from "../storage/repositories/investigation.repository.js";
import { parseSlackInteraction, parseSlackSocketMention, parseSlackSocketTrigger } from "./slack.events.js";
import type { SlackStreamingService } from "./slack.streaming.js";
import type { SlackFormatter } from "./slack.service.js";

type SocketEnvelope = { ack: () => Promise<void>; body: unknown };

/** Receives Slack events and button interactions over Socket Mode, with no public webhook endpoint. */
export class SlackSocketService {
  private readonly client: SocketModeClient;

  constructor(
    config: Pick<AppConfig, "SLACK_APP_TOKEN" | "SLACK_APPROVER_USER_IDS" | "SLACK_INVESTIGATION_CHANNEL_ID">,
    private readonly repository: InvestigationRepository,
    private readonly jira: JiraClient,
    private readonly queue: InvestigationQueue,
    private readonly streaming: SlackStreamingService,
    private readonly formatter: SlackFormatter,
    private readonly service: InvestigationService,
    private readonly logger: Logger,
  ) {
    this.client = new SocketModeClient({ appToken: config.SLACK_APP_TOKEN, autoReconnectEnabled: true });
    this.approvers = config.SLACK_APPROVER_USER_IDS;
    this.investigationChannelId = config.SLACK_INVESTIGATION_CHANNEL_ID;
    this.client.on("app_mention", (envelope: SocketEnvelope) => void this.receiveMention(envelope));
    this.client.on("interactive", (envelope: SocketEnvelope) => void this.receiveInteraction(envelope));
  }

  private readonly approvers: string[];
  private readonly investigationChannelId: string;

  async start(): Promise<void> {
    await this.client.start();
    this.logger.info("Slack Socket Mode connected");
  }

  disconnect(): Promise<void> { return this.client.disconnect(); }

  private async receiveMention(envelope: SocketEnvelope): Promise<void> {
    await envelope.ack();
    const mention = parseSlackSocketMention(envelope.body);
    if (!mention) return;
    let existingInvestigationId: string | null;
    try {
      existingInvestigationId = await this.repository.findInvestigationIdForSlackThread(mention.channelId, mention.threadTs);
    } catch (error) {
      this.logger.error({ err: error, eventId: mention.eventId }, "Could not look up the Slack investigation thread");
      return;
    }
    if (existingInvestigationId) {
      await this.receiveInvestigationQuestion(mention);
      return;
    }
    const trigger = parseSlackSocketTrigger(envelope.body);
    if (!trigger) {
      await this.streaming.postThreadMessage(mention.channelId, mention.threadTs, this.formatter.unsupportedRequest()).catch((error) => this.logger.error({ err: error }, "Could not send Slack Socket Mode scope reply"));
      return;
    }
    try {
      const issue = normalizeJiraIssue(await this.jira.getIssue(trigger.issueKey));
      const targetThread = await this.streaming.postRootMessage(this.investigationChannelId, this.formatter.investigationStarted({ issueKey: issue.key, summary: issue.summary, requesterUserId: trigger.userId }));
      const investigationId = await this.repository.startSlackInvestigation({
        eventId: trigger.eventId,
        channelId: this.investigationChannelId,
        threadTs: targetThread.ts,
        issue,
        question: trigger.question,
        requester: { userId: trigger.userId, teamId: trigger.teamId },
      });
      if (investigationId) {
        await this.streaming.postThreadMessage(trigger.channelId, trigger.threadTs, this.formatter.investigationRouted({ issueKey: issue.key, investigationChannelId: this.investigationChannelId })).catch((error) => this.logger.error({ err: error, eventId: trigger.eventId }, "Could not acknowledge routed Slack investigation"));
        this.queue.kick();
      }
    } catch (error) {
      this.logger.error({ err: error, issueKey: trigger.issueKey }, "Slack Socket Mode investigation trigger failed");
      await this.streaming.postThreadMessage(trigger.channelId, trigger.threadTs, this.formatter.error(`Could not fetch Jira issue ${trigger.issueKey}. Check the issue key and Jira access.`)).catch((slackError) => this.logger.error({ err: slackError }, "Could not report Socket Mode trigger failure to Slack"));
    }
  }

  private async receiveInvestigationQuestion(mention: NonNullable<ReturnType<typeof parseSlackSocketMention>>): Promise<void> {
    try {
      const question = mention.text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!question) return;
      const investigationId = await this.repository.enqueueSocketQuestion({
        eventId: mention.eventId,
        channelId: mention.channelId,
        threadTs: mention.threadTs,
        question,
        requester: { userId: mention.userId, teamId: mention.teamId },
      });
      if (investigationId) this.queue.kick();
    } catch (error) {
      this.logger.error({ err: error, eventId: mention.eventId }, "Slack Socket Mode follow-up question failed");
    }
  }

  private async receiveInteraction(envelope: SocketEnvelope): Promise<void> {
    await envelope.ack();
    const interaction = parseSlackInteraction(envelope.body);
    if (!interaction || !this.approvers.includes(interaction.userId)) return;
    try {
      if (interaction.kind === "control") return await this.handleControl(interaction);
      const decided = await this.repository.decideApproval(interaction.approvalId, interaction.userId, interaction.decision === "approve");
      if (!decided) return;
      if (decided.changed) {
        const approved = decided.approval.status === ApprovalStatus.APPROVED;
        await this.streaming.updateMessage(interaction.channelId, interaction.messageTs, this.formatter.approvalDecided(approved, interaction.userId));
        if (approved) this.queue.kick();
      }
    } catch (error) {
      this.logger.error({ err: error, interactionId: interaction.interactionId }, "Slack Socket Mode interaction failed");
    }
  }

  private async handleControl(interaction: Extract<ReturnType<typeof parseSlackInteraction>, { kind: "control" }>): Promise<void> {
    const investigation = await this.repository.getInvestigation(interaction.investigationId);
    if (!investigation) return;
    const issueKey = investigation.jiraIssue.issueKey;
    if (interaction.action === "stop") {
      const stopped = this.service.stop(interaction.investigationId);
      await this.streaming.updateMessage(interaction.channelId, interaction.messageTs, stopped ? this.formatter.stopping(issueKey) : this.formatter.inactiveRun(issueKey));
      return;
    }
    if (interaction.action === "continue") {
      const queued = await this.repository.continueInvestigation(interaction.investigationId, interaction.interactionId, { userId: interaction.userId, teamId: interaction.teamId });
      if (queued) {
        await this.streaming.updateMessage(interaction.channelId, interaction.messageTs, this.formatter.resuming(issueKey));
        this.queue.kick();
      }
      return;
    }
    const dismissed = await this.repository.dismissInvestigation(interaction.investigationId, interaction.interactionId);
    this.service.dismiss(interaction.investigationId);
    if (dismissed) await this.streaming.updateMessage(interaction.channelId, interaction.messageTs, this.formatter.dismissed(issueKey));
  }
}
