import { PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { createIsolatedPrisma } from '../middleware/prisma-filter.js';

const basePrisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

// Data isolation via Prisma Client Extension
export const prisma = createIsolatedPrisma(basePrisma);

// Export base client for migration scripts (no filtering)
export const basePrismaClient = basePrisma;

// Graceful shutdown
process.on('beforeExit', async () => {
  await basePrisma.$disconnect();
});
