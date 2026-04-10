/**
 * Centralized Error Logger — DB에 에러를 영구 저장
 *
 * 사용법:
 *   import { logError } from '../services/error-logger.js';
 *
 *   // 기존: somePromise.catch(() => {})
 *   // 변경: somePromise.catch(logError('email', '이메일 브리핑 실패', { userId }))
 *
 *   // try/catch 블록에서:
 *   catch (err) { logError('meeting', '전사 오류', { userId })(err); }
 */

import { basePrismaClient } from '../config/prisma.js';

export type ErrorCategory =
  | 'email'
  | 'meeting'
  | 'paper'
  | 'brain'
  | 'knowledge'
  | 'calendar'
  | 'embedding'
  | 'session'
  | 'background'
  | 'auth';

interface ErrorContext {
  userId?: string;
  [key: string]: unknown;
}

/**
 * 에러를 DB에 저장하고 콘솔에도 출력.
 * .catch() 체이닝 또는 try/catch 블록 내에서 사용.
 *
 * @returns (err: unknown) => void — Promise .catch()에 직접 전달 가능
 */
export function logError(
  category: ErrorCategory,
  message: string,
  context?: ErrorContext,
  severity: 'error' | 'warn' = 'error',
): (err: unknown) => void {
  return (err: unknown) => {
    const errObj = err instanceof Error ? err : new Error(String(err));
    const userId = context?.userId;

    // 콘솔 출력 (기존 동작 유지)
    if (severity === 'warn') {
      console.warn(`[${category}] ${message}:`, errObj.message);
    } else {
      console.error(`[${category}] ${message}:`, errObj.message);
    }

    // DB에 비동기 저장 (이 자체가 실패해도 무시 — 무한 루프 방지)
    const { userId: _u, ...contextRest } = context ?? {};
    basePrismaClient.errorLog.create({
      data: {
        userId: userId ?? null,
        category,
        severity,
        message: `${message}: ${errObj.message}`,
        context: Object.keys(contextRest).length > 0 ? JSON.parse(JSON.stringify(contextRest)) : undefined,
        stack: errObj.stack?.slice(0, 2000) ?? null,
      },
    }).catch((dbErr: any) => {
      console.error('[error-logger] DB 저장 실패:', dbErr.message);
    });
  };
}

/**
 * 에러를 즉시 로깅 (try/catch에서 직접 호출)
 */
export function logErrorSync(
  category: ErrorCategory,
  message: string,
  err: unknown,
  context?: ErrorContext,
  severity: 'error' | 'warn' = 'error',
): void {
  logError(category, message, context, severity)(err);
}
