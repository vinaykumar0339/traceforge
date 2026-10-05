import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  API_AUTH_TOKEN: z.string().min(16),
  JIRA_BASE_URL: z.string().url(),
  JIRA_EMAIL: z.string().email(),
  JIRA_API_TOKEN: z.string().min(1),
  SLACK_BOT_TOKEN: z.string().min(1),
  SLACK_APP_TOKEN: z.string().regex(/^xapp-/),
  // Channel ID, not a name. Each investigation gets a new root thread here.
  SLACK_INVESTIGATION_CHANNEL_ID: z.string().min(1),
  // Omit to use the Codex CLI bundled with @openai/codex-sdk. Set only for a managed CLI path.
  CODEX_COMMAND: z.string().min(1).optional(),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  WORKSPACE_ROOT: z.string().min(1).default("./workspaces"),
  REPOSITORIES_CONFIG_PATH: z.string().min(1).default("./repositories.yaml"),
  SLACK_UPDATE_INTERVAL_MS: z.coerce.number().int().min(500).max(10_000).default(1_000),
  SLACK_STREAMING_MODE: z.enum(["auto", "native", "updates"]).default("auto"),
  SLACK_APPROVER_USER_IDS: z.string().default("").transform((value) => value.split(",").map((id) => id.trim()).filter(Boolean)),
  SLACK_APPROVAL_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}
