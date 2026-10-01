import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const envelopeSchema = z.object({
  type: z.string(),
  challenge: z.string().optional(),
  event_id: z.string().optional(),
  team_id: z.string().optional(),
  event: z.object({
    type: z.string(), channel: z.string().optional(), thread_ts: z.string().optional(), ts: z.string().optional(),
    text: z.string().optional(), user: z.string().optional(), bot_id: z.string().optional(), subtype: z.string().optional(),
  }).optional(),
}).passthrough();

export interface SlackThreadMessage { eventId: string; channelId: string; threadTs: string; text: string; userId: string; teamId: string }
export interface SlackInteraction { approvalId: string; decision: "approve" | "reject"; userId: string; channelId: string; messageTs: string; interactionId: string }

export function verifySlackSignature(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^v0=[a-f0-9]{64}$/i.test(signature) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1_000 - Number(timestamp)) > 60 * 5) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody.toString("utf8")}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function parseSlackEnvelope(body: unknown): { challenge?: string; message?: SlackThreadMessage } {
  const parsed = envelopeSchema.parse(body);
  if (parsed.type === "url_verification") return { challenge: parsed.challenge };
  const event = parsed.event;
  if (parsed.type !== "event_callback" || !parsed.event_id || !parsed.team_id || !event || event.type !== "message" || event.subtype || event.bot_id || !event.channel || !event.thread_ts || !event.text || !event.user) return {};
  return { message: { eventId: parsed.event_id, channelId: event.channel, threadTs: event.thread_ts, text: event.text, userId: event.user, teamId: parsed.team_id } };
}

const interactionSchema = z.object({
  type: z.literal("block_actions"), user: z.object({ id: z.string() }), container: z.object({ channel_id: z.string(), message_ts: z.string() }),
  actions: z.array(z.object({ action_id: z.enum(["approval_approve", "approval_reject"]), value: z.string().min(1), action_ts: z.string() })).min(1),
});

export function parseSlackInteraction(payload: unknown): SlackInteraction | null {
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) return null;
  const action = parsed.data.actions[0]!;
  return { approvalId: action.value, decision: action.action_id === "approval_approve" ? "approve" : "reject", userId: parsed.data.user.id, channelId: parsed.data.container.channel_id, messageTs: parsed.data.container.message_ts, interactionId: `${parsed.data.user.id}:${action.action_ts}:${action.value}` };
}
