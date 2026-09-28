import { PrismaClient } from "@prisma/client";
import { getEnv } from "../env.js";

let client: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({ datasourceUrl: getEnv().DATABASE_URL });
  }
  return client;
}
