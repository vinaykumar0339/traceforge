export interface JiraComment {
  id: string;
  body: string;
  author: string | null;
  createdAt: string | null;
}

export interface NormalizedJiraIssue {
  id: string;
  key: string;
  summary: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  labels: string[];
  components: string[];
  issueType: string | null;
  reporter: string | null;
  assignee: string | null;
  project: string | null;
  comments: JiraComment[];
  attachments: Array<{ id: string; filename: string; contentUrl: string | null }>;
  customFields: Record<string, unknown>;
  raw: unknown;
}

export interface JiraWebhookEvent {
  webhookEvent: string;
  issue: { id: string; key: string; fields?: Record<string, unknown> };
  comment?: { id?: string; body?: unknown };
}
