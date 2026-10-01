import { PrismaClient } from "@prisma/client";

export function createDatabase(): PrismaClient {
  return new PrismaClient();
}
