# Traceforge

Traceforge is a single-process Express service that turns Jira issue events into evidence-based Codex investigations and continues those investigations in Slack threads. PostgreSQL persists the ticket, thread mapping, history, idempotency receipts, repository snapshots, and durable jobs; Redis is intentionally not required.

## Local setup

1. Install Node 22 and pnpm 11.
2. Copy `.env.example` to `.env`, generate strong values for `API_AUTH_TOKEN` and `JIRA_WEBHOOK_SECRET`, and enter Jira/Slack credentials.
3. Copy `repositories.example.yaml` to `repositories.yaml` and configure existing local Git repositories. These paths must be Git working trees; Traceforge does not clone them.
4. Start PostgreSQL: `pnpm db:up`.
5. Generate/apply the schema: `pnpm prisma:generate && pnpm prisma:migrate`.
6. Start the service: `pnpm dev`.

For deployment/CI, run `pnpm prisma:deploy` before `pnpm start`. Prisma migrations are committed under `prisma/migrations`; the application never changes a production schema automatically at startup.

## Repository worktrees

For a ticket such as `TF-7 — Save fails`, each configured local repository receives/reuses:

```text
workspaces/TF-7/<repository-name>/
branch: bugfix/codex-TF-7-save-fails
```

The worktree uses the configured `branch` (normally `main`) as its starting point. Creating a Git worktree shares Git objects with the original checkout and leaves its checked-out branch and files unchanged. Codex is invoked with a read-only sandbox, so investigations do not modify application code. Worktrees and branches remain available for later, explicitly approved fixes.

Install and authenticate the Codex CLI on the host running Traceforge, then leave `CODEX_COMMAND=codex` or point it to its absolute executable path. The runner executes `codex exec` with argument arrays (never a shell string), the investigation workspace as its working directory, and a read-only sandbox.

The prompt is built dynamically. Its effective context has this shape:

```json
{
  "jira": { "key": "TF-7", "summary": "Save fails", "labels": ["backend"] },
  "repositories": [{ "repositoryName": "backend", "workspacePath": "workspaces/TF-7/backend" }],
  "previousFindings": [],
  "conversation": [{ "source": "slack", "content": "Check iOS too" }],
  "currentQuestion": "Check iOS too"
}
```

## Configure Jira

Create an HTTPS Jira Cloud webhook for `jira:issue_created` and `jira:issue_updated` pointing to:

```text
https://your-public-host/webhooks/jira
```

Set a secret on the Jira webhook and place the same value in `JIRA_WEBHOOK_SECRET`. Traceforge validates the raw request `X-Hub-Signature` HMAC and uses `X-Atlassian-Webhook-Identifier` to deduplicate retries. The service fetches the complete issue from Jira REST API before Codex runs.

For local development, expose port 3000 with an HTTPS tunnel such as Cloudflare Tunnel or ngrok. Do not expose the operator API publicly without a reverse proxy in addition to its bearer token.

Example Jira payload:

```json
{
  "webhookEvent": "jira:issue_created",
  "issue": { "id": "10001", "key": "TF-7", "fields": { "summary": "Save fails", "labels": ["backend"] } }
}
```

## Configure Slack

Create a Slack app, install it in the target workspace, set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `SLACK_CHANNEL_ID`, and subscribe its Events API Request URL to:

```text
https://your-public-host/webhooks/slack
```

This deployment targets a private channel. Subscribe to `message.groups`, grant `chat:write` and `groups:history`, then invite the bot to the configured private channel. Slack URL verification is answered synchronously after signature validation. Human messages that are replies in a stored investigation thread enqueue a follow-up; bot messages and unrelated threads are ignored.

Traceforge filters Codex JSONL internally: Slack never receives raw agent protocol events, shell commands, or stderr. It uses Slack native streaming for eligible human thread replies and falls back to one throttled, rich Block Kit progress message when streaming is unavailable (including Jira-triggered investigations without a Slack recipient). Completed reports use structured Block Kit messages; full output is appended to `workspaces/<issue-key>/investigation.md`.

Enable **Interactivity & Shortcuts** in the Slack app and set its Request URL to:

```text
https://your-public-host/webhooks/slack/interactions
```

Configure approved Slack user IDs before enabling write-capable work:

```env
SLACK_STREAMING_MODE=auto
SLACK_APPROVER_USER_IDS=U0123456789,U9876543210
SLACK_APPROVAL_TIMEOUT_MINUTES=60
```

Read-only investigation never needs approval. A request to create/apply/implement a patch creates a durable approval card in the investigation thread. Only configured approvers can use its signed **Approve write access** or **Reject** actions. Approval allows Codex to modify the ticket's isolated worktrees only; it never permits writes to the configured source checkouts.

Example conversation:

```text
Traceforge: 🔎 Jira investigation started — TF-7 Save fails
Engineer:   Is this also happening in iOS?
Traceforge: 🔍 Investigating your question…
Traceforge: ✅ Investigation complete
            Android reaches the failing save path in …; iOS guards the equivalent state in …
```

Example Slack event:

```json
{
  "type": "event_callback",
  "event_id": "Ev123",
  "event": { "type": "message", "channel": "C123", "thread_ts": "1710000000.000100", "text": "Is this also happening in iOS?" }
}
```

## Operations and API

`GET /health` checks database connectivity. The following routes require `Authorization: Bearer <API_AUTH_TOKEN>`:

- `GET /investigations/:id`
- `GET /investigations/:id/events`
- `POST /investigations/:id/questions` with `{ "question": "Check the backend too" }`

Jobs are stored in PostgreSQL. At startup, interrupted `RUNNING` jobs are returned to `PENDING`; the in-process scheduler permits different tickets to run concurrently but only one Codex process per investigation. Duplicate Jira/Slack event identifiers are rejected transactionally.

## Verification

```bash
pnpm build
pnpm test
```

The test suite mocks Jira, Slack, and Codex behavior and uses a temporary local Git repository to verify ticket worktree creation/reuse. It does not require real credentials.
