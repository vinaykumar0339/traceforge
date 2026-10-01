import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { JiraWebhookEvent } from "./jira.types.js";

const webhookSchema = z.object({
  webhookEvent: z.string(),
  issue: z.object({ id: z.union([z.string(), z.number()]).transform(String), key: z.string().min(1), fields: z.record(z.unknown()).optional() }),
  comment: z.object({ id: z.union([z.string(), z.number()]).transform(String).optional(), body: z.unknown().optional() }).optional(),
}).passthrough();

export function parseJiraWebhook(body: unknown): JiraWebhookEvent | null {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success || !["jira:issue_created", "jira:issue_updated"].includes(parsed.data.webhookEvent)) return null;
  return parsed.data;
}

export function verifyJiraSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const [algorithm, received] = signature.split("=", 2);
  if (algorithm !== "sha256" || !received || !/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}
