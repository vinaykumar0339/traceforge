import type { AppConfig } from "../config/env.js";

export class JiraClient {
  constructor(private readonly config: Pick<AppConfig, "JIRA_BASE_URL" | "JIRA_EMAIL" | "JIRA_API_TOKEN">) {}

  async getIssue(issueKey: string): Promise<unknown> {
    const url = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, this.config.JIRA_BASE_URL);
    url.searchParams.set("expand", "names,renderedFields");
    const credentials = Buffer.from(`${this.config.JIRA_EMAIL}:${this.config.JIRA_API_TOKEN}`).toString("base64");
    const response = await fetch(url, { headers: { Authorization: `Basic ${credentials}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Jira issue fetch failed (${response.status})`);
    return response.json();
  }
}
