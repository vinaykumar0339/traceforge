import { Router } from "express";
import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import type { InvestigationQueue } from "../investigation/investigation.queue.js";
import type { InvestigationRepository } from "../storage/repositories/investigation.repository.js";

export function investigationRoutes(config: AppConfig, repository: InvestigationRepository, queue: InvestigationQueue): Router {
  const router = Router();
  router.use((request, response, next) => {
    if (request.header("authorization") !== `Bearer ${config.API_AUTH_TOKEN}`) return response.status(401).json({ error: "Unauthorized" });
    next();
  });
  router.get("/:id", async (request, response, next) => {
    try { const investigation = await repository.getInvestigation(request.params.id); if (!investigation) return response.status(404).json({ error: "Not found" }); return response.json(investigation); } catch (error) { next(error); }
  });
  router.get("/:id/events", async (request, response, next) => {
    try { const investigation = await repository.getInvestigation(request.params.id); if (!investigation) return response.status(404).json({ error: "Not found" }); return response.json(investigation.events); } catch (error) { next(error); }
  });
  router.post("/:id/questions", async (request, response, next) => {
    try {
      const body = z.object({ question: z.string().trim().min(1).max(8_000) }).parse(request.body);
      const investigation = await repository.getInvestigation(request.params.id);
      if (!investigation) return response.status(404).json({ error: "Not found" });
      await repository.enqueueApiQuestion(investigation.id, body.question);
      queue.kick();
      return response.status(202).json({ accepted: true });
    } catch (error) { next(error); }
  });
  return router;
}
