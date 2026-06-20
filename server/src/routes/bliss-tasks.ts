import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Capture, Prisma, Priority } from '@prisma/client';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyStudentTaskAssigned } from '../services/slack-notify.js';

/**
 * 외국어 detect — 한자/일본어가 한글보다 많으면 외국어로 판정.
 * detectLanguageForTranslation (bliss-slack-bot translate-config.ts) 와 같은 정책.
 * 영어 단독은 false (영어 title은 PI가 그대로 보길 원할 수 있음 — 기술 용어).
 */
function isLikelyForeignTitle(s: string): boolean {
  if (!s) return false;
  const cjk = (s.match(/[一-鿿]/g) ?? []).length;       // 한자 (중국어 + 일본어 한자)
  const hangul = (s.match(/[가-힣]/g) ?? []).length;     // 한글
  // 한자가 3자 이상이고 한자가 한글보다 많으면 외국어 (중국어/일본어)
  return cjk >= 3 && cjk > hangul;
}

/**
 * 외국어 → 한국어 번역 (Gemini 3.5 Flash).
 * 실패 시 null 반환 — caller가 원본 사용.
 * 6초 timeout — capture 등록 latency 우선 (실패해도 원본 title 그대로 진행).
 */
async function translateTitleToKorean(text: string): Promise<string | null> {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      systemInstruction:
        'You are a translator. Translate the user text to Korean (한국어). ' +
        'Output ONLY the translated text — no preamble, no explanation, no quotes. ' +
        'Keep English technical terms (e.g. MOF, PDMS, project titles) as-is. ' +
        'Never refuse or apologize — produce the best translation.',
      generationConfig: { temperature: 0.2, maxOutputTokens: 256 },
    });
    const callPromise = model.generateContent(text);
    const timeoutPromise = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('translate timeout')), 6000),
    );
    const result = await Promise.race([callPromise, timeoutPromise]);
    const translated = result.response.text().trim();
    return translated || null;
  } catch (e: any) {
    console.warn('[bliss-tasks] title 번역 실패 (silent):', e?.message);
    return null;
  }
}

const captureSchema = z.object({
  title: z.string().min(1).max(300),
  originalMessage: z.string().min(1).max(5000),
  requesterName: z.string().min(1).max(120),
  sourceChannel: z.string().min(1).max(120),
  slackPermalink: z.string().url().optional(),
  slackUserId: z.string().min(1).max(80).optional(),
  attachments: z.array(z.object({
    data: z.string().min(1).max(28_000_000),
    mimeType: z.string().min(1).max(100),
    name: z.string().max(200).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    slackUrl: z.string().url().optional(),
    slackPermalink: z.string().url().optional(),
  })).max(4).optional(),
  // Slack 메시지 dedup용 — reaction trigger가 짧게 두 번 들어와도 중복 capture 방지.
  slackChannel: z.string().min(1).max(80).optional(),
  slackTs: z.string().min(1).max(40).optional(),
  // metadata.fromPi=true 시 PI 본인 메시지에서 추출된 task → 검토 큐 거치지 않고 즉시 active.
  metadata: z.record(z.string(), z.any()).optional(),
});

const confirmSchema = z.object({
  actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ownerName: z.string().min(1).max(120),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  memo: z.string().max(2000).optional(),
});

const directCreateSchema = z.object({
  title: z.string().min(1).max(300),
  content: z.string().max(5000).optional(),
  actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ownerName: z.string().min(1).max(120),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  memo: z.string().max(2000).optional(),
});

const completeSchema = z.object({
  done: z.boolean().optional(),
});

const byAssigneeQuerySchema = z.object({
  name: z.string().min(1).max(120),
  status: z.enum(['active', 'completed', 'all']).optional().default('active'),
  dueWithin: z.coerce.number().int().min(0).max(365).optional(),
});

// In-memory mutex per (slackChannel, slackTs) — 같은 메시지에 reaction 동시 두 번이면
// 첫 요청이 끝날 때까지 두 번째는 같은 promise 결과 받음. Railway single-replica 환경에서
// race-safe. multi-replica로 가면 DB unique constraint 또는 advisory lock 필요.
const inFlightSlackCaptures = new Map<string, Promise<{ captureId: string; deduped: boolean }>>();

/**
 * 검토 큐에서 영구 차단할 Slack user IDs.
 *
 * 정책 결정 (2026-05-19):
 * - XIA BEIBEI (U0B176EUAR2): 일상 진행 보고/상의/언어 노이즈가 많아 검토 큐 폭증.
 *   해당 사용자와의 대화 자체를 검토 흐름에서 제외 — Notion task로 만들 가치 있는 정보가
 *   거의 없고, 별도 1:1 mpim에서 자체 관리되고 있음. translate 흐름은 별개로 유지.
 *
 * 차단 효과:
 * - mpim 그룹DM 경로: handleMpimAsReviewRequest의 capture API 호출 시 reject (204)
 * - reaction 경로: PI가 직접 reaction 추가한 경우라도 발신자가 차단 user면 reject
 * - cron 폴링 경로: cron-process-slack-inbox의 발신자 필터에서 사전 skip
 *
 * 사용자 명시 요청 또는 자동화 출처(BLISS-Bot 자체 cron)는 영향 없음.
 */
const BLOCKED_SLACK_USER_IDS = new Set<string>([
  'U0B176EUAR2', // XIA BEIBEI (Ph.D. '25)
]);

export function isBlockedSlackUserId(userId: string | undefined | null): boolean {
  if (!userId) return false;
  return BLOCKED_SLACK_USER_IDS.has(userId);
}

type BlissSource = {
  sourceChannel?: string;
  slackPermalink?: string;
  slackUserId?: string;
  requesterName?: string;
  attachments?: ReviewAttachmentMetadata[];
};

type ReviewAttachmentInput = NonNullable<z.infer<typeof captureSchema>['attachments']>[number];

type ReviewAttachmentMetadata = {
  memoId?: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  type?: string;
  suggestedAction?: string;
  textPreview?: string;
  slackUrl?: string;
  slackPermalink?: string;
  imageDataUrl?: string;
  error?: string;
};

function jsonObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Prisma.JsonObject;
  }
  return {};
}

function getBlissSource(value: Prisma.JsonValue | null | undefined): BlissSource {
  const metadata = jsonObject(value);
  const source = metadata.blissSource;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return source as BlissSource;
}

function getMeetingAction(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
  const metadata = jsonObject(value);
  const action = metadata.meetingAction;
  if (!action || typeof action !== 'object' || Array.isArray(action)) return {};
  return action as Prisma.JsonObject;
}

function parseDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function appendMemo(content: string, memo?: string): string {
  const trimmed = memo?.trim();
  if (!trimmed) return content;
  return `${content}\n\n[교수 메모]\n${trimmed}`.slice(0, 5000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function attachmentPreview(text: string, limit = 1200): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(';')[0].trim();
}

async function processReviewAttachments(input: {
  attachments?: ReviewAttachmentInput[];
  userId: string;
  labId: string | null;
}): Promise<ReviewAttachmentMetadata[]> {
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) return [];

  const { processUploadedFile } = await import('../services/file-processor.js');
  const processed: ReviewAttachmentMetadata[] = [];

  for (const attachment of attachments) {
    const name = attachment.name?.trim() || 'slack-attachment';
    const mimeType = normalizeMimeType(attachment.mimeType);
    const buffer = Buffer.from(attachment.data, 'base64');
    const sizeBytes = buffer.length;
    const base: ReviewAttachmentMetadata = {
      name,
      mimeType,
      sizeBytes,
      slackUrl: attachment.slackUrl,
      slackPermalink: attachment.slackPermalink,
    };

    try {
      const result = await processUploadedFile(buffer, name, mimeType);
      const memo = await prisma.memo.create({
        data: {
          userId: input.userId,
          labId: input.labId || undefined,
          title: `[Slack 첨부] ${result.filename}`,
          content: result.text || `[첨부 파일] ${result.filename} (${mimeType}, ${formatBytes(sizeBytes)})`,
          tags: ['slack-attachment', result.type],
          source: 'slack-attachment',
        },
      });

      processed.push({
        ...base,
        memoId: memo.id,
        type: result.type,
        suggestedAction: result.suggestedAction,
        textPreview: attachmentPreview(result.text || ''),
        imageDataUrl: mimeType.startsWith('image/') && sizeBytes <= 2 * 1024 * 1024
          ? `data:${mimeType};base64,${attachment.data}`
          : undefined,
      });
    } catch (error) {
      processed.push({
        ...base,
        error: error instanceof Error ? error.message : 'attachment processing failed',
      });
    }
  }

  return processed;
}

function formatAttachmentBlock(attachments: ReviewAttachmentMetadata[]): string {
  if (attachments.length === 0) return '';
  const lines = ['[첨부 파일]'];
  attachments.forEach((attachment, idx) => {
    lines.push(`${idx + 1}. ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.sizeBytes)})`);
    if (attachment.textPreview) lines.push(`   미리보기: ${attachment.textPreview}`);
    if (attachment.slackPermalink || attachment.slackUrl) lines.push(`   원본: ${attachment.slackPermalink || attachment.slackUrl}`);
    if (attachment.error) lines.push(`   처리 오류: ${attachment.error}`);
  });
  return lines.join('\n');
}

async function resolveOwner() {
  const ownerClerkId = env.LAB_OWNER_CLERK_ID || 'dev-user-seo';
  let user = await prisma.user.findFirst({ where: { clerkId: ownerClerkId } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        clerkId: ownerClerkId,
        email: env.LAB_OWNER_EMAIL || `${ownerClerkId}@labflow.app`,
        name: 'Jungmok Seo',
      },
    });
  }

  const lab = await prisma.lab.findFirst({
    where: { ownerId: user.id },
    select: { id: true },
  });

  return { user, labId: lab?.id ?? null };
}

function requireSyncToken(requestToken: string | undefined) {
  const expected = env.LABFLOW_SYNC_TOKEN;
  if (!expected) return { ok: false as const, status: 503, error: 'LABFLOW_SYNC_TOKEN not configured on server' };
  if (!requestToken || requestToken !== expected) return { ok: false as const, status: 401, error: 'invalid sync token' };
  return { ok: true as const };
}

function formatReviewItem(capture: Pick<Capture, 'id' | 'summary' | 'content' | 'metadata' | 'createdAt'>) {
  return {
    id: capture.id,
    title: capture.summary,
    content: capture.content,
    metadata: capture.metadata,
    createdAt: capture.createdAt,
  };
}

async function findReviewCapture(id: string, _userId: string) {
  // BLISS Lab은 단일 PI 환경 — userId 매칭 제거.
  // Slack 입력(blissSource)과 회의록 액션(meetingAction)을 같은 PI 검토 큐에서 처리.
  return prisma.capture.findFirst({
    where: {
      id,
      category: 'TASK',
      status: 'active',
      OR: [
        { metadata: { path: ['blissSource'], not: Prisma.JsonNull } },
        { metadata: { path: ['meetingAction'], not: Prisma.JsonNull } },
      ],
    },
  });
}

export async function blissTasksRoutes(app: FastifyInstance) {
  app.post('/api/bliss-tasks/captures', async (request, reply) => {
    const syncToken = request.headers['x-sync-token'] as string | undefined;
    const auth = requireSyncToken(syncToken);
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

    const body = captureSchema.parse(request.body);

    // ── 차단 user ID 사전 거부 ──
    // BLOCKED_SLACK_USER_IDS (현재 XIA BEIBEI)와의 대화는 검토 큐에 들어가지 않음.
    // capture 생성 자체 reject — DB row 만들지 않고 정상 응답 (caller에서 skip로 처리).
    // 204 No Content 대신 200 + { success: true, skipped: true, reason } 로 caller가 silent 처리 가능.
    if (isBlockedSlackUserId(body.slackUserId)) {
      console.log('[bliss-tasks:captures] blocked slackUserId 거부:', body.slackUserId, 'title=', body.title.slice(0, 60));
      return reply.code(200).send({
        success: true,
        skipped: true,
        reason: 'sender blocked from review queue',
        slackUserId: body.slackUserId,
      });
    }

    const { user, labId } = await resolveOwner();

    // PI 본인 메시지에서 추출된 task → 검토 단계 건너뛰고 즉시 active.
    // 학생 DM 발송 안 함 (PI 본인 할 일이라 알림 불필요).
    const fromPi = body.metadata?.fromPi === true;

    // ── 외국어 title 자동 번역 ──
    // mpim/reaction 등에서 raw text 첫 30~80자가 title로 들어오면 중국어/일본어 그대로일 수 있음.
    // BLISS-Bot Home 탭에서 PI가 한국어로 한눈에 파악할 수 있도록 자동 번역.
    // 원문(originalMessage)은 그대로 보존.
    let finalTitle = body.title;
    let translatedKoTitle: string | null = null;
    if (isLikelyForeignTitle(body.title)) {
      // 짧은 title보다 원문 전체를 번역하는 게 품질 ↑ — 첫 200자만 번역해서 latency 통제.
      const sourceForTranslation = body.originalMessage.slice(0, 200) || body.title;
      translatedKoTitle = await translateTitleToKorean(sourceForTranslation);
      if (translatedKoTitle) {
        // 번역 결과의 첫 줄 + 60자 cap (App Home 가독성)
        finalTitle = translatedKoTitle.split('\n')[0].slice(0, 60);
      }
    }

    // ── Idempotency — Slack reaction trigger 중복 등록 방지 ──
    // reaction이 짧게 두 번 들어오거나(race) 사용자가 같은 메시지에 다른 trigger emoji 추가하면
    // 중복 capture 가능. 같은 channel+ts는 하나의 capture만 유지.
    // Mutex는 single-process 안에서 atomic 보장. multi-replica로 확장 시 DB unique constraint 추가.
    //
    // slackChannel/slackTs는 reaction 흐름(events.ts)에서만 채워짐.
    // /검토요청 같은 슬래시 명령은 사용자 명시 입력이라 dedupe 대상이 아니다 — 같은 텍스트 두 번
    // 입력하는 것은 사용자 의도이므로 매번 신규 생성.
    const slackKey = body.slackChannel && body.slackTs
      ? `${labId}:${body.slackChannel}:${body.slackTs}`
      : null;

    const doCreateOrDedupe = async (): Promise<{ captureId: string; deduped: boolean }> => {
      // 1) DB에 이미 같은 channel+ts capture 있으면 reuse
      if (body.slackChannel && body.slackTs) {
        const existing = await prisma.capture.findFirst({
          where: {
            labId,
            AND: [
              { metadata: { path: ['blissSource', 'slackChannel'], equals: body.slackChannel } },
              { metadata: { path: ['blissSource', 'slackTs'], equals: body.slackTs } },
            ],
          },
          select: { id: true },
        });
        if (existing) return { captureId: existing.id, deduped: true };
      }
      const reviewAttachments = await processReviewAttachments({
        attachments: body.attachments,
        userId: user.id,
        labId,
      });
      // 2) 신규 생성
      // content: 외국어 원문일 경우 "📝 한글 요약: ... --- 원문 ---" prefix 추가하여 PI가 양쪽 다 볼 수 있게.
      const contentParts: string[] = [];
      if (translatedKoTitle && translatedKoTitle.trim()) {
        contentParts.push(`📝 한글 번역: ${translatedKoTitle.trim()}`);
        contentParts.push('');
        contentParts.push('--- 원문 ---');
      }
      contentParts.push(body.originalMessage);
      const attachmentBlock = formatAttachmentBlock(reviewAttachments);
      if (attachmentBlock) {
        contentParts.push('');
        contentParts.push(attachmentBlock);
      }
      const finalContent = contentParts.join('\n').slice(0, 8000);

      const created = await prisma.capture.create({
        data: {
          userId: user.id,
          labId,
          content: finalContent,
          summary: finalTitle.slice(0, 200),
          category: 'TASK',
          tags: fromPi
            ? ['bliss-slack', 'pi-self-task']
            : ['bliss-slack', 'review-queue'],
          priority: 'MEDIUM',
          confidence: 1.0,
          modelUsed: 'bliss-task-capture',
          sourceType: 'slack',
          reviewed: fromPi,  // PI 본인 메시지면 자동 confirm
          status: 'active',
          metadata: {
            blissSource: {
              sourceChannel: body.sourceChannel,
              slackPermalink: body.slackPermalink,
              slackUserId: body.slackUserId,
              requesterName: body.requesterName,
              attachments: reviewAttachments,
              // dedup key — reaction trigger의 같은 메시지 중복 방지용
              slackChannel: body.slackChannel,
              slackTs: body.slackTs,
            },
            ...(translatedKoTitle ? { translatedKoTitle, originalTitle: body.title } : {}),
            ...(fromPi ? { fromPi: true } : {}),
            capturedAt: new Date().toISOString(),
          },
        },
      });
      return { captureId: created.id, deduped: false };
    };

    let result: { captureId: string; deduped: boolean };
    if (slackKey) {
      // 같은 키 in-flight 요청이 있으면 그것을 기다림 (atomic dedupe).
      // waiter는 새 capture를 만들지 않았으므로 항상 deduped:true로 표시.
      const existing = inFlightSlackCaptures.get(slackKey);
      if (existing) {
        const { captureId } = await existing;
        result = { captureId, deduped: true };
      } else {
        const promise = doCreateOrDedupe();
        inFlightSlackCaptures.set(slackKey, promise);
        try {
          result = await promise;
        } finally {
          // 5초 후 mutex 해제 — 그 사이 같은 키 요청은 dedupe로 잡히고, 이후엔 DB findFirst로 잡힘
          setTimeout(() => inFlightSlackCaptures.delete(slackKey), 5000);
        }
      }
    } else {
      result = await doCreateOrDedupe();
    }

    return reply.code(result.deduped ? 200 : 201).send({
      success: true,
      captureId: result.captureId,
      deduped: result.deduped,
      fromPi,
    });
  });

  app.get('/api/bliss-tasks/review-queue', { preHandler: authMiddleware }, async (_request) => {
    // BLISS Lab 단일 PI 환경 — userId 매칭 제거.
    // BLISS Slack에서 들어온 task는 항상 dev-user-seo / LAB_OWNER_CLERK_ID로 저장되지만
    // web 로그인한 Clerk userId와 다를 수 있어 매칭 실패. Slack/meeting metadata로 식별.
    const captures = await prisma.capture.findMany({
      where: {
        reviewed: false,
        category: 'TASK',
        status: 'active',
        OR: [
          { metadata: { path: ['blissSource'], not: Prisma.JsonNull } },
          { metadata: { path: ['meetingAction'], not: Prisma.JsonNull } },
        ],
      },
      select: {
        id: true,
        summary: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return captures.map(formatReviewItem);
  });

  app.patch('/api/bliss-tasks/:id/confirm', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = confirmSchema.parse(request.body);
    const capture = await findReviewCapture(id, request.userId!);
    if (!capture) return reply.code(404).send({ error: '검토 대기 항목을 찾을 수 없습니다' });

    // 멱등성: 이미 확정(reviewed=true)된 항목을 다시 confirm하면 학생에게 DM이 재발송되던 문제.
    // findReviewCapture는 reviewed 필터가 없어 확정된 항목도 잡힌다. 재확정 시 DM은 1회만.
    const alreadyConfirmed = capture.reviewed === true;

    const currentMetadata = jsonObject(capture.metadata);
    const blissSource = getBlissSource(capture.metadata);
    const meetingAction = getMeetingAction(capture.metadata);
    const actionDate = parseDateOnly(body.actionDate);
    const notificationAt = new Date().toISOString();
    const meetingTitle = typeof currentMetadata.meetingTitle === 'string'
      ? currentMetadata.meetingTitle
      : typeof meetingAction.meetingTitle === 'string'
        ? meetingAction.meetingTitle
        : undefined;
    const sourceLabel = meetingTitle
      ? `회의: ${meetingTitle}`
      : blissSource.sourceChannel
        ? `Slack: ${blissSource.sourceChannel}`
        : undefined;
    const sourceUrl = blissSource.slackPermalink;

    await prisma.capture.update({
      where: { id: capture.id },
      data: {
        reviewed: true,
        actionDate,
        priority: (body.priority || capture.priority) as Priority,
        content: appendMemo(capture.content, body.memo),
        metadata: {
          ...currentMetadata,
          notifiedAt: notificationAt,
          assignedOwner: body.ownerName,
          confirmedAt: notificationAt,
        },
      },
    });

    // 최초 확정일 때만 학생에게 DM (재확정 시 중복 알림 방지)
    const notifyResult = alreadyConfirmed
      ? { ok: true as const }
      : await notifyStudentTaskAssigned({
          ownerName: body.ownerName,
          taskTitle: capture.summary,
          actionDate,
          slackPermalink: blissSource.slackPermalink,
          sourceLabel,
          sourceUrl,
          memo: body.memo,
        });

    return {
      success: true,
      notified: notifyResult.ok,
      alreadyConfirmed,
      ...(notifyResult.ok ? {} : { error: (notifyResult as any).error }),
    };
  });

  app.patch('/api/bliss-tasks/:id/hold', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const capture = await findReviewCapture(id, request.userId!);
    if (!capture) return reply.code(404).send({ error: '검토 대기 항목을 찾을 수 없습니다' });

    // status='on_hold'로 변경 → review-queue에서 자동 제외 (status='active' 필터)
    // heldAt도 metadata에 기록 (audit + 추후 재활성화 시 사용)
    await prisma.capture.update({
      where: { id: capture.id },
      data: {
        status: 'on_hold',
        metadata: {
          ...jsonObject(capture.metadata),
          heldAt: new Date().toISOString(),
        },
      },
    });

    return { success: true };
  });

  app.patch('/api/bliss-tasks/:id/archive', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const capture = await findReviewCapture(id, request.userId!);
    if (!capture) return reply.code(404).send({ error: '검토 대기 항목을 찾을 수 없습니다' });

    await prisma.capture.update({
      where: { id: capture.id },
      data: { status: 'archived' },
    });

    return { success: true };
  });

  // ── Slack ↔ ResearchFlow 양방향 동기화 ──────────────────────────
  // bliss-slack-bot이 BLISS-Bot Home 탭의 button 클릭 처리 시 호출.
  // X-Sync-Token 인증 (relay) + body에 actionType('archive'|'hold')과 captureId.
  // capture는 metadata.blissSource로 식별 (Slack channel+ts 또는 직접 id 둘 다 지원).
  const slackSyncActionSchema = z.object({
    captureId: z.string().min(1).optional(),
    slackChannel: z.string().min(1).optional(),
    slackTs: z.string().min(1).optional(),
    action: z.enum(['archive', 'hold']),
  }).refine(d => d.captureId || (d.slackChannel && d.slackTs), {
    message: 'captureId 또는 slackChannel+slackTs 둘 중 하나 필수',
  });

  app.post('/api/bliss-tasks/sync-action', async (request, reply) => {
    const syncToken = request.headers['x-sync-token'] as string | undefined;
    const auth = requireSyncToken(syncToken);
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

    const body = slackSyncActionSchema.parse(request.body);

    // capture 조회 — captureId 우선, 없으면 slackChannel+ts로 metadata 검색
    let capture: { id: string; status: string; metadata: Prisma.JsonValue } | null = null;
    if (body.captureId) {
      capture = await prisma.capture.findUnique({
        where: { id: body.captureId },
        select: { id: true, status: true, metadata: true },
      });
    } else if (body.slackChannel && body.slackTs) {
      capture = await prisma.capture.findFirst({
        where: {
          AND: [
            { metadata: { path: ['blissSource', 'slackChannel'], equals: body.slackChannel } },
            { metadata: { path: ['blissSource', 'slackTs'], equals: body.slackTs } },
          ],
        },
        select: { id: true, status: true, metadata: true },
      });
    }
    if (!capture) return reply.code(404).send({ error: '검토 항목을 찾을 수 없습니다' });

    if (body.action === 'archive') {
      await prisma.capture.update({
        where: { id: capture.id },
        data: { status: 'archived' },
      });
    } else if (body.action === 'hold') {
      await prisma.capture.update({
        where: { id: capture.id },
        data: {
          status: 'on_hold',
          metadata: {
            ...jsonObject(capture.metadata),
            heldAt: new Date().toISOString(),
          },
        },
      });
    }

    return reply.send({ success: true, captureId: capture.id, action: body.action });
  });

  // 교수가 web에서 직접 task 추가 (검토 단계 건너뛰고 즉시 학생 알림)
  app.post('/api/bliss-tasks/direct-create', { preHandler: authMiddleware }, async (request) => {
    const body = directCreateSchema.parse(request.body);
    const { user, labId } = await resolveOwner();

    const actionDate = parseDateOnly(body.actionDate);
    const notifiedAt = new Date().toISOString();

    const capture = await prisma.capture.create({
      data: {
        userId: user.id,
        labId,
        content: appendMemo(body.content || body.title, body.memo),
        summary: body.title.slice(0, 200),
        category: 'TASK',
        tags: ['bliss-direct'],
        priority: (body.priority || 'MEDIUM') as Priority,
        confidence: 1.0,
        modelUsed: 'bliss-direct-create',
        sourceType: 'manual',
        reviewed: true,
        status: 'active',
        actionDate,
        metadata: {
          blissDirect: {
            assignedOwner: body.ownerName,
            notifiedAt,
          },
          capturedAt: new Date().toISOString(),
        },
      },
    });

    const notifyResult = await notifyStudentTaskAssigned({
      ownerName: body.ownerName,
      taskTitle: body.title,
      actionDate,
      memo: body.memo,
    });

    return {
      success: true,
      captureId: capture.id,
      notified: notifyResult.ok,
      ...(notifyResult.ok ? {} : { error: notifyResult.error }),
    };
  });

  // 진행 중 task 목록 (확정된 것 + 직접 추가한 것 모두)
  // ── 학생 이름으로 active task 조회 (BLISS-Bot get_my_tasks용, X-Sync-Token) ──
  // 실제 metadata 구조:
  //   - direct-create 후: metadata.blissDirect.assignedOwner
  //   - confirm 후:      metadata.assignedOwner (FLAT, blissConfirmed는 생성되지 않음)
  //   - blissSource는 둘 다 가짐 (Slack 원본 메타)
  // 학생용 응답에서 PI 교수 메모(content 안의 "[교수 메모]" 섹션)는 노출하지 않음.
  app.get('/api/bliss-tasks/by-assignee', async (request, reply) => {
    const syncToken = request.headers['x-sync-token'] as string | undefined;
    const auth = requireSyncToken(syncToken);
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

    const queryParseResult = byAssigneeQuerySchema.safeParse(request.query);
    if (!queryParseResult.success) {
      return reply.code(400).send({ error: 'invalid_query', detail: queryParseResult.error.flatten() });
    }
    const q = queryParseResult.data;
    // 한글 NFC normalize + trim — Slack display name과 일관된 매칭.
    const name = q.name.normalize('NFC').trim();
    const status = q.status;
    const dueWithin = q.dueWithin ?? null;

    const where: Prisma.CaptureWhereInput = {
      category: 'TASK',
      reviewed: true,
      OR: [
        // direct-create: metadata.blissDirect.assignedOwner
        { metadata: { path: ['blissDirect', 'assignedOwner'], equals: name } },
        // confirm: metadata.assignedOwner (flat) — 검토 큐 거친 task의 실제 저장 위치
        { metadata: { path: ['assignedOwner'], equals: name } },
      ],
    };

    if (status === 'completed') where.completed = true;
    else if (status === 'all') { /* no completed filter */ }
    else where.completed = false; // default 'active'

    if (dueWithin !== null && dueWithin >= 0) {
      const limit = new Date();
      limit.setDate(limit.getDate() + dueWithin);
      where.actionDate = { lte: limit, not: null };
    }

    const captures = await prisma.capture.findMany({
      where,
      select: {
        id: true,
        summary: true,
        // content는 PI 메모를 포함할 수 있으므로 학생 응답에서 제외
        metadata: true,
        actionDate: true,
        priority: true,
        completed: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ actionDate: 'asc' }, { createdAt: 'desc' }],
      take: 25,
    });

    return reply.send({
      assignee: name,
      count: captures.length,
      items: captures.map(c => {
        const meta = (c.metadata as Prisma.JsonObject | null) ?? {};
        const direct = (meta.blissDirect as Prisma.JsonObject | null) ?? {};
        // blissSource (Slack 원본) 또는 blissDirect에서 slackPermalink 추출
        const slackPermalink =
          ((meta.blissSource as Prisma.JsonObject | null)?.slackPermalink as string | undefined)
          ?? (direct.slackPermalink as string | undefined)
          ?? null;
        return {
          id: c.id,
          title: c.summary,
          actionDate: c.actionDate,
          priority: c.priority,
          completed: c.completed,
          createdAt: c.createdAt,
          // PI 메모(memo)는 학생용 응답에서 의도적으로 제외 (평가/내부 코멘트 노출 방지)
          slackPermalink,
        };
      }),
    });
  });

  app.get('/api/bliss-tasks/active', { preHandler: authMiddleware }, async () => {
    const captures = await prisma.capture.findMany({
      where: {
        category: 'TASK',
        status: 'active',
        reviewed: true,
        OR: [
          { metadata: { path: ['blissSource'], not: Prisma.JsonNull } },
          { metadata: { path: ['blissDirect'], not: Prisma.JsonNull } },
          { metadata: { path: ['meetingAction'], not: Prisma.JsonNull } },
        ],
      },
      select: {
        id: true,
        summary: true,
        content: true,
        metadata: true,
        actionDate: true,
        priority: true,
        completed: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: [{ actionDate: 'asc' }, { createdAt: 'desc' }],
      take: 100,
    });

    return captures.map((c) => ({
      id: c.id,
      title: c.summary,
      content: c.content,
      metadata: c.metadata,
      actionDate: c.actionDate,
      priority: c.priority,
      completed: c.completed,
      completedAt: c.completedAt,
      createdAt: c.createdAt,
    }));
  });

  // task 완료 토글
  app.patch('/api/bliss-tasks/:id/complete', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = completeSchema.parse(request.body || {});
    const done = body.done !== false; // 기본 true

    const capture = await prisma.capture.findFirst({
      where: {
        id,
        category: 'TASK',
        OR: [
          { metadata: { path: ['blissSource'], not: Prisma.JsonNull } },
          { metadata: { path: ['blissDirect'], not: Prisma.JsonNull } },
          { metadata: { path: ['meetingAction'], not: Prisma.JsonNull } },
        ],
      },
    });
    if (!capture) return reply.code(404).send({ error: 'Task를 찾을 수 없습니다' });

    await prisma.capture.update({
      where: { id: capture.id },
      data: {
        completed: done,
        completedAt: done ? new Date() : null,
        status: done ? 'completed' : 'active',
      },
    });

    return { success: true, completed: done };
  });
}
