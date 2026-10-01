import { promises as fs } from "node:fs";
import path from "node:path";
import type { InvestigationRepository } from "../storage/repositories/investigation.repository.js";
import { normalizeJiraIssue } from "../jira/jira.service.js";
import type { InvestigationContext } from "../agent/codex.context.js";

export class InvestigationContextBuilder {
  constructor(private readonly repository: InvestigationRepository) {}

  async build(investigationId: string, workspacePath: string, currentQuestion: string | null): Promise<InvestigationContext> {
    const investigation = await this.repository.getInvestigation(investigationId);
    if (!investigation) throw new Error(`Investigation not found: ${investigationId}`);
    let investigationMarkdown = "";
    try { investigationMarkdown = await fs.readFile(path.join(workspacePath, "investigation.md"), "utf8"); } catch { /* first run */ }
    return {
      jira: normalizeJiraIssue(investigation.jiraIssue.snapshot),
      repositories: investigation.repositorySnapshots.map((snapshot) => ({ repositoryName: snapshot.repositoryName, platform: snapshot.platform ?? undefined, sourcePath: snapshot.sourcePath, workspacePath: snapshot.workspacePath, branch: snapshot.branch, commitSha: snapshot.commitSha, sourceUrlTemplate: snapshot.sourceUrlTemplate ?? undefined })),
      previousFindings: investigation.latestFindings,
      recentEvents: investigation.events.map((event) => ({ type: event.type, source: event.source, content: event.content, createdAt: event.createdAt })),
      currentQuestion,
      workspacePath,
      investigationMarkdown,
    };
  }
}
