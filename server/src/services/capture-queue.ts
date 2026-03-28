/**
 * 캡처 비동기 처리 큐
 *
 * BullMQ 대신 인프로세스 큐를 사용 (Redis 불필요)
 * - 캡처 저장 후 비동기로 L5 지식 그래프 엔티티 추출
 * - 같은 엔티티가 반복 언급되면 weight 자동 강화
 *
 * 향후 BullMQ로 업그레이드 시 인터페이스 동일하게 유지
 */

import { prisma } from '../config/prisma.js';
import { buildGraphFromText } from './knowledge-graph.js';

interface CaptureJob {
  captureId: string;
  labId: string;
  userId: string;
  content: string;
  type: string;
}

const queue: CaptureJob[] = [];
let processing = false;

// ── 큐에 Job 추가 ──────────────────────────────────────
export function enqueueCaptureProcessing(job: CaptureJob): void {
  queue.push(job);
  if (!processing) {
    processNext();
  }
}

// ── 큐 처리 ───────────────────────────────────────────
async function processNext(): Promise<void> {
  if (queue.length === 0) {
    processing = false;
    return;
  }

  processing = true;
  const job = queue.shift()!;

  try {
    await processCaptureJob(job);
  } catch (error) {
    console.error(`[CaptureQueue] Job failed for capture ${job.captureId}:`, error);
  }

  // 다음 Job을 비동기로 처리 (이벤트 루프 블로킹 방지)
  setImmediate(() => processNext());
}

// ── 캡처 → L5 지식 그래프 추출 ─────────────────────────
async function processCaptureJob(job: CaptureJob): Promise<void> {
  console.log(`[CaptureQueue] Processing capture ${job.captureId} (${job.type})`);

  try {
    // buildGraphFromText: 텍스트에서 엔티티 추출 → KnowledgeNode/Edge upsert
    await buildGraphFromText(job.userId, job.content, 'capture' as any);

    // Capture metadata에 추출 완료 기록
    await prisma.capture.update({
      where: { id: job.captureId },
      data: {
        metadata: {
          graphExtracted: true,
          extractedAt: new Date().toISOString(),
        } as any,
      },
    });

    console.log(`[CaptureQueue] Graph extraction done for capture ${job.captureId}`);
  } catch (error) {
    console.error(`[CaptureQueue] L5 extraction failed for ${job.captureId}:`, error);
    // 실패해도 캡처 자체는 이미 저장됨 — 사용자 경험에 영향 없음
  }
}
