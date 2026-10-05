import express, { type ErrorRequestHandler } from "express";
import { pinoHttp } from "pino-http";
import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import type { Logger } from "pino";
import type { AppConfig } from "./config/env.js";
import type { InvestigationQueue } from "./investigation/investigation.queue.js";
import { healthRoutes } from "./routes/health.routes.js";
import { investigationRoutes } from "./routes/investigation.routes.js";
import type { InvestigationRepository } from "./storage/repositories/investigation.repository.js";

export interface AppDependencies {
  config: AppConfig;
  db: PrismaClient;
  repository: InvestigationRepository;
  queue: InvestigationQueue;
  logger: Logger;
}

export function createApp(dependencies: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(pinoHttp({ logger: dependencies.logger }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.use(healthRoutes(dependencies.db));
  app.use("/investigations", investigationRoutes(dependencies.config, dependencies.repository, dependencies.queue));
  app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    dependencies.logger.error({ err: error }, "Request failed");
    if (error instanceof ZodError) return response.status(400).json({ error: "Invalid request", details: error.issues });
    return response.status(500).json({ error: "Internal server error" });
  };
  app.use(errors);
  return app;
}
