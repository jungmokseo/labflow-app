/**
 * Prisma data isolation: AsyncLocalStorage 기반 요청 컨텍스트
 *
 * Prisma 6.x는 $use middleware를 제거했으므로,
 * Client Extension의 query 레벨에서 userId/labId 자동 필터링 수행
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  userId: string;
  labId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

const USER_ID_MODELS = ['Capture', 'Meeting', 'Channel', 'KnowledgeNode', 'UserPreference', 'Memo'] as const;
const LAB_ID_MODELS = ['Project', 'Publication', 'LabMember', 'DomainDict', 'PaperAlert'] as const;

type UserIdModel = typeof USER_ID_MODELS[number];
type LabIdModel = typeof LAB_ID_MODELS[number];

function isUserIdModel(model: string): model is UserIdModel {
  return (USER_ID_MODELS as readonly string[]).includes(model);
}

function isLabIdModel(model: string): model is LabIdModel {
  return (LAB_ID_MODELS as readonly string[]).includes(model);
}

/**
 * Prisma Client Extension으로 데이터 격리 적용
 */
export function createIsolatedPrisma(basePrisma: PrismaClient) {
  return basePrisma.$extends({
    query: {
      $allModels: {
        async findMany({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async findFirst({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async findUnique({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async count({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async aggregate({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async update({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async updateMany({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async delete({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
        async deleteMany({ model, args, query }) {
          injectFilter(model, args);
          return query(args);
        },
      },
    },
  });
}

function injectFilter(model: string, args: any) {
  const ctx = requestContext.getStore();
  if (!ctx) return;

  if (isUserIdModel(model)) {
    args.where = { ...args.where, userId: ctx.userId };
  }
  if (isLabIdModel(model) && ctx.labId) {
    args.where = { ...args.where, labId: ctx.labId };
  }
}

function injectCreateData(model: string, args: any) {
  const ctx = requestContext.getStore();
  if (!ctx) return;

  if (isUserIdModel(model)) {
    args.data = { ...args.data, userId: ctx.userId };
  }
  if (isLabIdModel(model) && ctx.labId) {
    args.data = { ...args.data, labId: ctx.labId };
  }
}
