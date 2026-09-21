import { PrismaClient } from '@prisma/client';

// Next dev-mode hot reloading re-evaluates modules, which would otherwise open a new pool of
// SQLite connections on every edit until the process runs out of file handles.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
