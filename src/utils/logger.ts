import pino from "pino";

export function createLogger(level: string): pino.Logger {
  return pino({ level, redact: ["req.headers.authorization", "req.headers.x-hub-signature", "jiraApiToken", "slackBotToken"] });
}
