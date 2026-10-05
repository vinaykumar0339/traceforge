import { z } from "zod";

const socketEventSchema = z.object({
  type: z.literal("event_callback"),
  event_id: z.string().min(1),
  team_id: z.string().min(1),
  event: z.object({
    type: z.literal("app_mention"),
    channel: z.string().min(1),
    ts: z.string().min(1),
    thread_ts: z.string().optional(),
    text: z.string().min(1),
    user: z.string().min(1),
    bot_id: z.string().optional(),
  }),
});

export interface SlackSocketMention {
  eventId: string;
  channelId: string;
  threadTs: string;
  text: string;
  userId: string;
  teamId: string;
}

export interface SlackInvestigationTrigger extends SlackSocketMention {
  issueKey: string;
  question: string;
}

export type SlackInteraction =
  | { kind: "approval"; approvalId: string; decision: "approve" | "reject"; userId: string; teamId: string; channelId: string; messageTs: string; interactionId: string }
  | { kind: "control"; action: "stop" | "continue" | "dismiss"; investigationId: string; userId: string; teamId: string; channelId: string; messageTs: string; interactionId: string };

/** Parses an app mention that names a Jira issue. `investigate` is optional for natural-language requests. */
export function parseSlackSocketTrigger(body: unknown): SlackInvestigationTrigger | null {
  const mention = parseSlackSocketMention(body);
  if (!mention) return null;
  const command = mention.text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const issueKey = extractJiraIssueKey(command);
  if (!issueKey) return null;
  const remainder = command
    .replace(/<https?:\/\/[^>|]+(?:\|[^>]+)?>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^investigate\b/i, "")
    .replace(new RegExp(`\\b${escapeRegex(issueKey)}\\b`, "i"), "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    ...mention,
    issueKey,
    question: remainder ? `Investigate ${issueKey}. Additional request: ${remainder}` : `Investigate Jira issue ${issueKey}.`,
  };
}

/** Parses all human app mentions, including questions in an existing investigation thread. */
export function parseSlackSocketMention(body: unknown): SlackSocketMention | null {
  const parsed = socketEventSchema.safeParse(body);
  if (!parsed.success || parsed.data.event.bot_id) return null;
  return {
    eventId: parsed.data.event_id,
    channelId: parsed.data.event.channel,
    threadTs: parsed.data.event.thread_ts ?? parsed.data.event.ts,
    text: parsed.data.event.text,
    userId: parsed.data.event.user,
    teamId: parsed.data.team_id,
  };
}

/** Supports `TF-123`, Jira /browse/TF-123 URLs, modern project issue URLs, and Slack-formatted links. */
export function extractJiraIssueKey(value: string): string | null {
  const match = value.match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
  if (match?.[1]) return match[1].toUpperCase();
  const projectIssue = value.match(/\/projects\/([A-Z][A-Z0-9]+)\/issues\/(\d+)/i);
  return projectIssue ? `${projectIssue[1]!.toUpperCase()}-${projectIssue[2]!}` : null;
}

const interactionSchema = z.object({
  type: z.literal("block_actions"), user: z.object({ id: z.string() }), team: z.object({ id: z.string() }), container: z.object({ channel_id: z.string(), message_ts: z.string() }),
  actions: z.array(z.object({ action_id: z.enum(["approval_approve", "approval_reject", "investigation_stop", "investigation_continue", "investigation_dismiss"]), value: z.string().min(1), action_ts: z.string() })).min(1),
});

export function parseSlackInteraction(payload: unknown): SlackInteraction | null {
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const action = parsed.data.actions[0]!;
  const common = { userId: parsed.data.user.id, teamId: parsed.data.team.id, channelId: parsed.data.container.channel_id, messageTs: parsed.data.container.message_ts, interactionId: `${parsed.data.user.id}:${action.action_ts}:${action.value}` };
  if (action.action_id === "approval_approve" || action.action_id === "approval_reject") return { kind: "approval", approvalId: action.value, decision: action.action_id === "approval_approve" ? "approve" : "reject", ...common };
  return { kind: "control", action: action.action_id.replace("investigation_", "") as "stop" | "continue" | "dismiss", investigationId: action.value, ...common };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
