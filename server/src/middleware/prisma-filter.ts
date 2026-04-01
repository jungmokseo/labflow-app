/**
 * Prisma data isolation: AsyncLocalStorage 기반 요청 컨텍스트
 *
 * Prisma 6.x Client Extension의 $allOperations에서
 * userId/labId 자동 필터링 + 자동 주입 수행.
 *
 * - READ: WHERE에 userId/labId 자동 주입
 * - WRITE: WHERE에 userId/labId 자동 주입 (소유권 검증)
 * - CREATE: data에 userId/labId 자동 주입
 */
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  userId: string;
  labId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

// userId 필드로 격리되는 모델
const USER_ID_MODELS = new Set([
  'Capture', 'Meeting', 'Channel', 'KnowledgeNode', 'KnowledgeEdge',
  'UserPreference', 'Memo', 'Message', 'ChannelSummary',
  'GmailToken', 'EmailProfile',
]);

// labId 필드로 격리되는 모델
const LAB_ID_MODELS = new Set([
  'Project', 'Publication', 'LabMember', 'DomainDict', 'PaperAlert',
]);

// WHERE 필터를 주입하는 작업들
const FILTER_OPERATIONS = new Set([
  'findMany', 'findFirst', 'findUnique', 'count', 'aggregate',
  'update', 'updateMany', 'delete', 'deleteMany',
  'upsert', // upsert의 where 절에도 주입
]);

// data에 userId/labId를 주입하는 작업들
const CREATE_OPERATIONS = new Set([
  'create', 'createMany', 'createManyAndReturn', 'upsert',
]);

/**
 * Prisma Client Extension으로 데이터 격리 적용
 */
export function createIsolatedPrisma(basePrisma: PrismaClient) {
  return basePrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          const ctx = requestContext.getStore();
          if (!ctx) return query(args);

          const isUserModel = USER_ID_MODELS.has(model);
          const isLabModel = LAB_ID_MODELS.has(model);

          // WHERE 필터 주입 (READ + WRITE + upsert.where)
          if (FILTER_OPERATIONS.has(operation)) {
            if (isUserModel) {
              args.where = { ...args.where, userId: ctx.userId };
            }
            if (isLabModel && ctx.labId) {
              args.where = { ...args.where, labId: ctx.labId };
            }
          }

          // CREATE data 주입
          if (CREATE_OPERATIONS.has(operation)) {
            if (operation === 'create') {
              if (args.data) {
                if (isUserModel && !args.data.userId) args.data.userId = ctx.userId;
                if (isLabModel && ctx.labId && !args.data.labId) args.data.labId = ctx.labId;
              }
            } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
              if (Array.isArray(args.data)) {
                for (const item of args.data) {
                  if (isUserModel && !item.userId) item.userId = ctx.userId;
                  if (isLabModel && ctx.labId && !item.labId) item.labId = ctx.labId;
                }
              }
            } else if (operation === 'upsert') {
              if (args.create) {
                if (isUserModel && !args.create.userId) args.create.userId = ctx.userId;
                if (isLabModel && ctx.labId && !args.create.labId) args.create.labId = ctx.labId;
              }
            }
          }

          return query(args);
        },
      },
    },
  });
}
