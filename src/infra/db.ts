import { Prisma, PrismaClient } from '@prisma/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function createDb(url?: string): Db {
  return new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
}

const PRISMA_TO_PG: Record<string, string> = { P2002: '23505', P2003: '23503' };

/** Extracts the Postgres SQLSTATE from the various Prisma error shapes. */
export function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (!e || typeof e !== 'object') return undefined;
  if (e.code && PRISMA_TO_PG[e.code]) return PRISMA_TO_PG[e.code];
  if (e.meta?.code) return e.meta.code; // P2010 raw query failure carries the SQLSTATE here
  if (e.message?.includes('violates exclusion constraint')) return '23P01';
  return undefined;
}
