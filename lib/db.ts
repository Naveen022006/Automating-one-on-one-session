import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Connection pool limits. These protect the database from being overwhelmed: a burst of requests queues for a
 * pooled connection (and fails fast after DATABASE_CONNECT_TIMEOUT_MS) instead of opening unbounded connections,
 * and a runaway query is cancelled by Postgres after DATABASE_STATEMENT_TIMEOUT_MS. Hosted poolers (Supabase
 * session pooler, PgBouncer) have small connection caps, so keep DATABASE_POOL_MAX low per process.
 */
export const poolConfig = {
  connectionString: process.env.DATABASE_URL,
  max: intEnv("DATABASE_POOL_MAX", 10),
  idleTimeoutMillis: intEnv("DATABASE_IDLE_TIMEOUT_MS", 30_000),
  connectionTimeoutMillis: intEnv("DATABASE_CONNECT_TIMEOUT_MS", 10_000),
  statement_timeout: intEnv("DATABASE_STATEMENT_TIMEOUT_MS", 15_000),
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter: new PrismaPg(poolConfig),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
