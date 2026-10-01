import type { NormalizedJiraIssue } from "../jira/jira.types.js";
import type { SlackBlock, SlackMessage } from "./slack.client.js";
import type { WorkspaceSnapshot } from "../workspace/workspace.manager.js";

export class SlackFormatter {
  initial(issue: NormalizedJiraIssue): SlackMessage { return { text: `Jira investigation started: ${issue.key} — ${issue.summary}`, blocks: [{ type: "header", text: { type: "plain_text", text: "🔎 Jira investigation started" } }, { type: "section", text: { type: "mrkdwn", text: `*${issue.key} — ${issue.summary}*` }, fields: [{ type: "mrkdwn", text: "*Status*\nInvestigating" }, { type: "mrkdwn", text: `*Priority*\n${issue.priority ?? "Not set"}` }, { type: "mrkdwn", text: `*Reporter*\n${issue.reporter ?? "Unassigned"}` }, { type: "mrkdwn", text: `*Assignee*\n${issue.assignee ?? "Unassigned"}` }] }, { type: "context", elements: [{ type: "mrkdwn", text: "Reply in this thread to ask follow-up questions." }] }] }; }
  progress(question: string | null): SlackMessage { return { text: "Investigation in progress", blocks: [{ type: "header", text: { type: "plain_text", text: "🔍 Investigation in progress" } }, { type: "section", text: { type: "mrkdwn", text: question ? `*Question*\n${question}` : "Preparing workspaces and tracing the relevant code path." } }] }; }
  complete(issue: NormalizedJiraIssue, result: string, sources: WorkspaceSnapshot[] = []): SlackMessage {
    return { text: `Investigation complete: ${issue.key} — ${issue.summary}`, blocks: [{ type: "header", text: { type: "plain_text", text: "✅ Investigation complete" } }, { type: "section", text: { type: "mrkdwn", text: `*${issue.key} — ${issue.summary}*` } }, { type: "divider" }, { type: "section", text: { type: "mrkdwn", text: toSlackEvidence(result, sources).slice(0, 2_900) || "No findings were returned." } }, { type: "context", elements: [{ type: "mrkdwn", text: "Source evidence is pinned to the ticket worktree snapshot. Full details are preserved in the investigation workspace." }] }] };
  }
  approval(input: { issueKey: string; summary: string; approvalId: string; question: string; expiresAt: Date }): SlackMessage { const blocks: SlackBlock[] = [{ type: "header", text: { type: "plain_text", text: "🟠 Approval required" } }, { type: "section", text: { type: "mrkdwn", text: `*${input.issueKey} — ${input.summary}*\n\n*Requested action*\nAllow Codex to create a patch in this ticket's isolated worktree.\n\n*Request*\n${input.question.slice(0, 1_500)}` } }, { type: "section", fields: [{ type: "mrkdwn", text: "*Scope*\nTicket worktrees only" }, { type: "mrkdwn", text: `*Expires*\n<!date^${Math.floor(input.expiresAt.getTime() / 1_000)}^{date_short_pretty} at {time}|soon>` }] }, { type: "actions", block_id: `approval-${input.approvalId}`, elements: [{ type: "button", text: { type: "plain_text", text: "Approve write access" }, style: "primary", action_id: "approval_approve", value: input.approvalId, confirm: { title: { type: "plain_text", text: "Approve workspace write access?" }, text: { type: "mrkdwn", text: "Codex may modify only this ticket's isolated Git worktrees." }, confirm: { type: "plain_text", text: "Approve" }, deny: { type: "plain_text", text: "Cancel" } } }, { type: "button", text: { type: "plain_text", text: "Reject" }, style: "danger", action_id: "approval_reject", value: input.approvalId }] }]; return { text: `Approval required for ${input.issueKey}`, blocks }; }
  approvalDecided(approved: boolean, approver: string): SlackMessage { return { text: approved ? "Write access approved" : "Write access rejected", blocks: [{ type: "header", text: { type: "plain_text", text: approved ? "✅ Write access approved" : "⛔ Write access rejected" } }, { type: "section", text: { type: "mrkdwn", text: approved ? `Approved by <@${approver}>. Codex will continue in the isolated ticket worktree.` : `Rejected by <@${approver}>. The investigation remains read-only.` } }] }; }
  error(reason: string): SlackMessage { return { text: `Investigation failed: ${reason}`, blocks: [{ type: "header", text: { type: "plain_text", text: "⚠️ Investigation failed" } }, { type: "section", text: { type: "mrkdwn", text: `*Reason*\n${reason.slice(0, 2_800)}` } }] }; }
}

/** Converts Codex Markdown into Slack mrkdwn without leaking unusable local paths. */
export function toSlackEvidence(result: string, sources: WorkspaceSnapshot[]): string {
  let formatted = result.replace(/\*\*([^*\n]+)\*\*/g, "*$1*").replace(/\\-/g, "-");
  for (const source of [...sources].sort((left, right) => right.workspacePath.length - left.workspacePath.length)) {
    const prefix = escapeRegex(`${source.workspacePath}/`);
    const expression = new RegExp(`\\[([^\\]]+)\\]\\(${prefix}([^):]+)(?::(\\d+))?\\)`, "g");
    formatted = formatted.replace(expression, (_match, label: string, relativePath: string, line: string | undefined) => {
      const fallback = `*${cleanLabel(label)}* — \`${source.repositoryName}/${relativePath}${line ? `:${line}` : ""}\``;
      const url = source.sourceUrlTemplate ? sourceUrl(source.sourceUrlTemplate, source.commitSha, relativePath, line) : undefined;
      return url ? `<${url}|${cleanLabel(label)}>` : fallback;
    });
  }
  return formatted.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => `<${url}|${cleanLabel(label)}>`);
}

function sourceUrl(template: string, ref: string, relativePath: string, line?: string): string {
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  const file = relativePath.split("/").at(-1) ?? relativePath;
  const withoutLineAnchor = line ? template : template.replace(/#L\{line\}|#\{file\}-\{line\}|#lines-\{line\}/g, "");
  return withoutLineAnchor.replaceAll("{ref}", encodeURIComponent(ref)).replaceAll("{path}", encodedPath).replaceAll("{file}", encodeURIComponent(file)).replaceAll("{line}", line ? encodeURIComponent(line) : "");
}
function cleanLabel(value: string): string { return value.replace(/[|>]/g, "").trim(); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
