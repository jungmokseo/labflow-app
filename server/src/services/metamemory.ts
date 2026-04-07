/**
 * Metamemory — 신뢰도 계산 & 접근 추적
 */

import { prisma } from '../config/prisma.js';

/**
 * 메타기억 신뢰도 계산
 * - 시간 경과에 따라 confidence가 감소 (반감기: 6개월)
 * - 자주 조회되는 정보는 감소 속도가 느림 (accessCount로 보정)
 * - lastVerified가 있으면 그 시점부터 감소 시작
 */
export function calculateConfidence(record: {
  confidence: number;
  createdAt: Date;
  lastVerified?: Date | null;
  accessCount: number;
  lastAccessed?: Date | null;
}): number {
  const now = Date.now();
  const baseDate = record.lastVerified?.getTime() || record.createdAt.getTime();
  const daysSinceBase = (now - baseDate) / (1000 * 60 * 60 * 24);

  const accessBoost = 1 + Math.log10(Math.max(record.accessCount, 1));
  const halfLife = 180 * accessBoost;

  const decayFactor = Math.pow(2, -daysSinceBase / halfLife);
  const computed = record.confidence * decayFactor;

  return Math.max(0, Math.min(1, Number(computed.toFixed(3))));
}

/**
 * 오래된 정보에 대한 경고 메시지 생성
 */
export function getStaleWarning(confidence: number, createdAt: Date, lastVerified?: Date | null): string | null {
  if (confidence >= 0.7) return null;

  const refDate = lastVerified || createdAt;
  const monthsAgo = Math.floor((Date.now() - refDate.getTime()) / (1000 * 60 * 60 * 24 * 30));

  if (confidence < 0.3) {
    return `[주의] 이 정보는 ${monthsAgo}개월 전에 등록되었으며, 신뢰도가 매우 낮습니다 (${(confidence * 100).toFixed(0)}%). 최신 정보인지 반드시 확인해 주세요.`;
  }
  if (confidence < 0.5) {
    return `[주의] 이 정보는 ${monthsAgo}개월 전에 등록되었습니다. 최신 정보인지 확인이 필요할 수 있습니다 (신뢰도 ${(confidence * 100).toFixed(0)}%).`;
  }
  return `[참고] 이 정보는 ${monthsAgo}개월 전 기준입니다 (신뢰도 ${(confidence * 100).toFixed(0)}%).`;
}

/**
 * Lab Memory 항목 조회 시 accessCount/lastAccessed 업데이트 (비동기, fire-and-forget)
 */
export async function trackAccess(table: 'memo' | 'labMember' | 'project' | 'publication', ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date();
  try {
    const updatePromises = ids.map(id =>
      (prisma as any)[table].update({
        where: { id },
        data: {
          accessCount: { increment: 1 },
          lastAccessed: now,
        },
      }).catch((err: any) => console.error('[background] trackAccess update:', err.message || err))
    );
    await Promise.all(updatePromises);
  } catch {
    // 접근 추적 실패는 무시
  }
}
