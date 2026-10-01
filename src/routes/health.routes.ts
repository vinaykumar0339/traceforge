import { Router } from "express";
import type { PrismaClient } from "@prisma/client";

export function healthRoutes(db: PrismaClient): Router {
  const router = Router();
  router.get("/health", async (_request, response, next) => {
    try { await db.$queryRaw`SELECT 1`; response.json({ status: "ok" }); } catch (error) { next(error); }
  });
  return router;
}
