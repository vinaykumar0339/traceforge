# Traceforge

Traceforge is a single-process Express service that turns Slack Socket Mode commands into evidence-based Jira/Codex investigations and continues them in Slack threads. PostgreSQL persists the ticket, thread mapping, history, idempotency receipts, repository snapshots, and durable jobs; Redis is intentionally not required.

## Local setup

1. Install Node 22 and pnpm 11.
2. Copy `.env.example` to `.env`, generate a strong `API_AUTH_TOKEN`, and enter Jira plus Slack bot/app credentials. Never commit tokens.
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

Slack cannot open filesystem paths such as `/Users/.../Login.java:122`. Traceforge therefore displays those as compact source evidence, for example `android/library/Login.java:122`. To make the evidence a clickable hosted-source permalink, optionally add `sourceUrlTemplate` to each repository. Use `{ref}`, `{path}`, `{file}`, and `{line}` as placeholders. For Bitbucket Cloud:

```yaml
sourceUrlTemplate: https://bitbucket.org/your-workspace/android/src/{ref}/{path}#{file}-{line}
```

Traceforge replaces `{ref}` with the captured commit SHA, `{path}` with the repository-relative path, `{file}` with its final file name, and `{line}` with the source line. The link stays pinned to the source revision that Codex investigated. Keep this unset when the repository has no browser-accessible URL.

Traceforge uses the official `@openai/codex-sdk`, which manages the Codex CLI process and streams typed thread events. Authenticate Codex on the host as usual. The SDK uses its bundled CLI by default; set `CODEX_COMMAND` only when the host requires a managed CLI executable. Traceforge stores the SDK thread ID, so a Slack follow-up resumes the same Codex conversation.

The Codex SDK emits typed lifecycle, tool, plan, file-change, and message events. Traceforge maps those into native Slack `ChatStreamer` chunks and task cards when supported, or throttled rich Block Kit updates otherwise. It never sends raw command output or internal reasoning to Slack.

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

No Jira webhook is required. Traceforge fetches the full Jira ticket through REST only after an authorized Slack Socket Mode command supplies its key. Keep `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN` configured.

## Configure Slack

Create a Slack app, install it in the target workspace, enable **Socket Mode**, and configure `SLACK_BOT_TOKEN` and a rotated `SLACK_APP_TOKEN` with the `connections:write` scope. No Slack Request URL, signing secret, or public HTTPS tunnel is required for events or interactive controls.

Subscribe to the `app_mention` bot event and enable **Interactivity & Shortcuts**; Socket Mode delivers both over the WebSocket. Grant `chat:write`, `app_mentions:read`, and the required private-channel history scope, then invite the bot to the channel.

Set the dedicated Slack investigation destination channel ID. Traceforge accepts ticket mentions in any channel where the bot has been invited:

```text
SLACK_INVESTIGATION_CHANNEL_ID=<traceforce-app channel ID>
```

Start a ticket investigation with a key or a Jira link; the `investigate` keyword is optional:

```text
@Traceforge investigate TF-123
@Traceforge investigate https://your-domain.atlassian.net/browse/TF-123
@Traceforge please check https://your-domain.atlassian.net/browse/TF-123
```

The app acknowledges the Socket Mode envelope immediately, fetches the Jira ticket, creates a new investigation thread in `SLACK_INVESTIGATION_CHANNEL_ID`, and acknowledges it in the originating thread. Reusing a ticket starts/resumes its durable Codex thread in the new investigation thread. To ask a follow-up, mention Traceforge in that investigation thread, for example `@Traceforge check iOS too`. Mentions without a Jira ticket outside an investigation thread receive a brief reminder that Traceforge only handles Jira investigations.

Traceforge filters Codex SDK events internally: Slack never receives internal reasoning, raw commands, or stderr. It uses Slack native streaming for eligible command threads and falls back to one throttled, rich Block Kit progress message when streaming is unavailable. Completed reports use structured Block Kit messages; full output is appended to `workspaces/<issue-key>/investigation.md`.

Configure approved Slack user IDs before enabling write-capable work:

```env
SLACK_STREAMING_MODE=auto
SLACK_APPROVER_USER_IDS=U0123456789,U9876543210
SLACK_APPROVAL_TIMEOUT_MINUTES=60
```

Before a Slack follow-up can change code, Traceforge asks Codex through a constrained, read-only intent gate to classify the request semantically as read-only, patch, commit, push, or uncertain. It does not use keyword matching. Patch, commit, and push requests receive a durable approval card that states the exact scope; uncertain requests fail closed as read-only. Only configured approvers can use these signed actions. A change-and-push approval additionally allows a normal (never force) push of that ticket branch to `origin`; it never alters the configured source checkout or another branch.

Every active Codex run also has a signed Slack control card for configured approvers. **Stop** aborts the active SDK turn and leaves the investigation paused. **Continue** queues the same investigation against its stored Codex thread; a previously approved write/push request is classified again and requires fresh approval. **Dismiss** cancels pending work but retains the isolated worktree and any already-created local changes.

Example conversation:

```text
Traceforge: 🔎 Jira investigation started — TF-7 Save fails
Engineer:   Is this also happening in iOS?
Traceforge: 🔍 Investigating your question…
Traceforge: ✅ Investigation complete
            Android reaches the failing save path in …; iOS guards the equivalent state in …
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
