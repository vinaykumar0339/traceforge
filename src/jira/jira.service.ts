import type { NormalizedJiraIssue } from "./jira.types.js";

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "displayName" in value && typeof value.displayName === "string") return value.displayName;
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string") return value.name;
  return null;
}

function documentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if ("text" in node && typeof node.text === "string") parts.push(node.text);
    if ("content" in node && Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(value);
  return parts.join("\n") || null;
}

export function normalizeJiraIssue(input: unknown): NormalizedJiraIssue {
  const issue = input as { id?: unknown; key?: unknown; fields?: Record<string, unknown> };
  const fields = issue.fields ?? {};
  const comments = ((fields.comment as { comments?: unknown[] } | undefined)?.comments ?? []).map((comment) => {
    const item = comment as Record<string, unknown>;
    return { id: String(item.id ?? ""), body: documentText(item.body) ?? "", author: text(item.author), createdAt: typeof item.created === "string" ? item.created : null };
  });
  const customFields = Object.fromEntries(Object.entries(fields).filter(([key]) => key.startsWith("customfield_")));
  return {
    id: String(issue.id ?? ""), key: String(issue.key ?? ""), summary: typeof fields.summary === "string" ? fields.summary : "Untitled Jira issue",
    description: documentText(fields.description), status: text(fields.status), priority: text(fields.priority),
    labels: Array.isArray(fields.labels) ? fields.labels.filter((value): value is string => typeof value === "string") : [],
    components: Array.isArray(fields.components) ? fields.components.map(text).filter((value): value is string => value !== null) : [],
    issueType: text(fields.issuetype), reporter: text(fields.reporter), assignee: text(fields.assignee),
    project: text(fields.project), comments,
    attachments: Array.isArray(fields.attachment) ? fields.attachment.map((item) => {
      const attachment = item as Record<string, unknown>;
      return { id: String(attachment.id ?? ""), filename: String(attachment.filename ?? ""), contentUrl: typeof attachment.content === "string" ? attachment.content : null };
    }) : [], customFields, raw: input,
  };
}
