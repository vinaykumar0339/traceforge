import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logger.js";
import { createDatabase } from "./storage/database.js";
import { InvestigationRepository } from "./storage/repositories/investigation.repository.js";
import { loadRepositories } from "./workspace/repository.manager.js";
import { WorkspaceManager } from "./workspace/workspace.manager.js";
import { JiraClient } from "./jira/jira.client.js";
import { SlackClient } from "./slack/slack.client.js";
import { SlackStreamingService } from "./slack/slack.streaming.js";
import { SlackFormatter } from "./slack/slack.service.js";
import { CodexRunner } from "./agent/codex.runner.js";
import { InvestigationService } from "./investigation/investigation.service.js";
import { InvestigationQueue } from "./investigation/investigation.queue.js";
import { WriteIntentClassifier } from "./investigation/write-intent.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createDatabase();
  await db.$connect();
  const repositories = await loadRepositories(config.REPOSITORIES_CONFIG_PATH);
  const repository = new InvestigationRepository(db);
  const workspace = new WorkspaceManager(config.WORKSPACE_ROOT, repositories, logger);
  const formatter = new SlackFormatter();
  const streaming = new SlackStreamingService(new SlackClient(config.SLACK_BOT_TOKEN), config.SLACK_UPDATE_INTERVAL_MS, config.SLACK_STREAMING_MODE);
  const codex = new CodexRunner(config.CODEX_COMMAND);
  const writeIntent = new WriteIntentClassifier(codex, Math.min(config.CODEX_TIMEOUT_MS, 60_000), process.cwd());
  const service = new InvestigationService(repository, new JiraClient(config), workspace, codex, streaming, formatter, config.CODEX_TIMEOUT_MS, config.SLACK_CHANNEL_ID, config.SLACK_APPROVAL_TIMEOUT_MINUTES, writeIntent, logger);
  const queue = new InvestigationQueue(repository, service, logger);
  await queue.start();
  const app = createApp({ config, db, repository, queue, logger, streaming, formatter });
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, "Traceforge listening"));
  const shutdown = async (): Promise<void> => { queue.stop(); server.close(); await db.$disconnect(); };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
