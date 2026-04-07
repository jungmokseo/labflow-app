/**
 * 미니브레인 (Lab Memory) Routes — 4층 기억 구조 (메타기억 포함) + 의도 분류 + 멀티홉 질의 체이닝
 *
 * POST   /api/brain/chat              → 미니브레인 대화 (4층 기억 + 멀티홉 DB 조회)
 * GET    /api/brain/channels           → 사용자 채널 목록
 * POST   /api/brain/channels           → 새 채널 생성
 * GET    /api/brain/channels/:id       → 채널 메시지 목록
 * DELETE /api/brain/channels/:id       → 채널 삭제
 * POST   /api/brain/memo               → 메모 저장 (수동)
 * GET    /api/brain/search             → Lab Memory 자연어 검색
 * GET    /api/brain/stale/:labId       → 오래된 정보 목록 (confidence < threshold)
 * POST   /api/brain/verify/:memoryId   → 정보 최신 확인 처리
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { basePrismaClient } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { aiRateLimiter, trackAICost, COST_PER_CALL } from '../middleware/rate-limiter.js';
import { env } from '../config/env.js';
import { hybridSearch, rerank, validateResponse, isRagReady, embedAndStore } from '../services/rag-engine.js';
import { generateEmbedding, searchPapers } from '../services/embedding-service.js';
import { getGraphContextForQuery } from '../services/knowledge-graph.js';

// ── Modularized imports ──────────────────────────────
import { buildCoreSystemPrompt, PROGRESS_MAP } from '../prompts/core-system.js';
import {
  type Intent, type ClassifiedIntent, type ConversationTurn,
  classifyIntent, detectCorrection, loadIntentCorrections, saveIntentCorrection,
} from '../prompts/intent-classifier.js';
import { calculateConfidence, getStaleWarning, trackAccess } from '../services/metamemory.js';
import { maybeGenerateSummary, autoExtractInfo, generateSessionTitle } from '../services/session-manager.js';
import { determineShadowType, getOrCreateShadow, saveShadowMessage, compressForShadow } from '../tools/shadow-session.js';
import { executeMultiHopQuery, handleDbQuery } from '../tools/db-query-handler.js';
import {
  handleEmailBriefing, handleEmailRead, handleEmailReplyDraft,
  handleEmailPreference, handleEmailToolMessage, handleEmailQuery,
} from '../tools/email-handler.js';
import { handleCalendarQuery, handleCalendarCreate, handlePapersToolMessage, handleMeetingToolMessage } from '../tools/calendar-handler.js';

// ── Schemas ─────────────────────────────────────────
const chatSchema = z.object({
  channelId: z.string().optional(),
  message: z.string().min(1),
  fileId: z.string().optional(),
  newSession: z.boolean().optional(),
  stream: z.boolean().optional(),
});

const createChannelSchema = z.object({
  type: z.enum(['BRAIN', 'MEETING', 'PAPER', 'EMAIL']).default('BRAIN'),
  name: z.string().optional(),
});

const memoSchema = z.object({
  content: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().default('manual'),
});

const searchSchema = z.object({
  query: z.string().min(1),
  type: z.enum(['all', 'memo', 'project', 'publication', 'member', 'meeting']).default('all'),
});

// ══════════════════════════════════════════════════════
//  TOOL-SPECIFIC HANDLER (레거시 래퍼 — 기존 호출 유지)
// ══════════════════════════════════════════════════════

type ToolName = 'email' | 'papers' | 'meeting' | 'calendar';

async function handleToolMessage(
  tool: ToolName,
  message: string,
  userId: string,
  lab: any,
  labId?: string,
  _recentTurns?: Array<{ role: string; content: string }>,
): Promise<{ response: string; intent: string; metadata?: any }> {
  const labIdStr = lab?.id || labId;

  switch (tool) {
    case 'email':
      return handleEmailToolMessage(message, userId);
    case 'papers':
      return handlePapersToolMessage(message, userId, labIdStr);
    case 'meeting':
      return handleMeetingToolMessage(message, userId);
    case 'calendar':
      return handleCalendarQuery(message, userId);
    default:
      return { response: '알 수 없는 도구입니다.', intent: 'unknown_tool' };
  }
}

// ══════════════════════════════════════════════════════
//  3-LAYER CONTEXT BUILDER
// ══════════════════════════════════════════════════════

// ── Lab Profile 캐시 (5분 TTL) ──────────────────────
const labProfileCache = new Map<string, { data: string; expiry: number }>();
const LAB_CACHE_TTL = 5 * 60 * 1000;

async function getCachedLabContext(labId: string): Promise<string> {
  const cached = labProfileCache.get(labId);
  if (cached && Date.now() < cached.expiry) return cached.data;

  let context = '';
  const lab = await prisma.lab.findUnique({
    where: { id: labId },
    include: {
      members: { where: { active: true }, take: 20 },
      projects: { where: { status: 'active' }, take: 10 },
      domainDict: { take: 50 },
    },
  });

  if (lab) {
    context += `연구실: ${lab.name}\n`;
    context += `소속: ${lab.institution || '미등록'} ${lab.department || ''}\n`;
    context += `연구 분야: ${lab.researchFields.join(', ') || '미등록'}\n`;
    if (lab.members.length > 0) {
      context += `구성원 (${lab.members.length}명): ${lab.members.map(m => `${m.name}(${m.role})`).join(', ')}\n`;
    }
    if (lab.projects.length > 0) {
      context += `진행 과제: ${lab.projects.map(p => `${p.name}[PM:${p.pm || '미지정'}]`).join(', ')}\n`;
    }
    if (lab.domainDict.length > 0) {
      context += `전문용어 사전: ${lab.domainDict.slice(0, 20).map(d => `${d.wrongForm}→${d.correctForm}`).join(', ')}\n`;
    }

    const sharedMemos = await prisma.memo.findMany({
      where: { labId, shared: true, source: { in: ['faq', 'regulation'] } },
      take: 30,
      orderBy: { accessCount: 'desc' },
    });
    if (sharedMemos.length > 0) {
      const faqMemos = sharedMemos.filter(m => m.source === 'faq');
      const regMemos = sharedMemos.filter(m => m.source === 'regulation');
      if (faqMemos.length > 0) {
        context += `FAQ (${faqMemos.length}건): ${faqMemos.slice(0, 10).map(m => m.title || m.content.slice(0, 30)).join(', ')}\n`;
      }
      if (regMemos.length > 0) {
        context += `규정/매뉴얼 (${regMemos.length}건): ${regMemos.slice(0, 10).map(m => m.title || m.content.slice(0, 30)).join(', ')}\n`;
      }
    }
  }

  labProfileCache.set(labId, { data: context, expiry: Date.now() + LAB_CACHE_TTL });
  return context;
}

async function build5LayerContext(channelId: string, userId: string, labId: string | null, query?: string, intent?: string): Promise<string> {
  const [summaries, labContext, shadows] = await Promise.all([
    prisma.channelSummary.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 3,
    }),
    labId ? getCachedLabContext(labId) : Promise.resolve(''),
    prisma.channel.findMany({
      where: { userId, shadow: true, archived: false },
    }),
  ]);

  let context = '';

  if (summaries.length > 0) {
    context += '## 이전 대화\n';
    context += summaries.map(s => s.summaryText).join('\n---\n');
    context += '\n\n';
  }

  if (labContext) {
    context += '## 연구실 정보\n' + labContext + '\n';
  }

  if (shadows.length > 0) {
    const shadowResults = await Promise.all(shadows.map(async (shadow) => {
      const [shadowSummary, recentShadowMsgs] = await Promise.all([
        prisma.channelSummary.findFirst({
          where: { channelId: shadow.id },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.message.findMany({
          where: { channelId: shadow.id },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
      ]);

      if (!shadowSummary && recentShadowMsgs.length === 0) return '';

      const label = shadow.shadowType === 'email' ? '이메일' : shadow.shadowType === 'calendar' ? '캘린더' : '지식';
      let text = `## ${label} 관련 정보\n`;
      if (shadowSummary) text += shadowSummary.summaryText + '\n';
      if (recentShadowMsgs.length > 0) {
        text += recentShadowMsgs.reverse().map(m =>
          `${m.role === 'user' ? '질문' : '답변'}: ${m.content.slice(0, 200)}`
        ).join('\n') + '\n';
      }
      return text + '\n';
    }));

    context += shadowResults.filter(Boolean).join('');
  }

  // L5: Graph + Vector Context
  const skipIntents = ['capture_create', 'capture_list', 'capture_complete', 'save_memo', 'email_briefing', 'email_read', 'email_reply_draft', 'calendar_create', 'add_dict'];
  const simplePatterns = /^(안녕|고마워|감사|ㅎㅎ|ㅋㅋ|ok|네|응|좋아|알겠)/i;

  if (query && !skipIntents.includes(intent || '') && !simplePatterns.test(query.trim())) {
    try {
      const graphContext = await getGraphContextForQuery(query, userId, labId, { timeoutMs: 800 });
      if (graphContext.contextText) {
        context += '## 관련 지식 맥락 (자동 수집)\n';
        context += graphContext.contextText + '\n';
        context += '\n위 정보는 데이터베이스에서 자동 수집된 맥락입니다. 응답 시 이 정보를 활용하되, 맥락에 없는 내용은 추측하지 말고 "데이터에 없음"이라고 답하세요.\n\n';
      }
    } catch (err) {
      console.warn('[Layer5] graph context failed, proceeding without:', err);
    }
  }

  return context;
}

// ══════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════

/**
 * 30일 이상 된 자유 대화 세션을 자동 아카이브 (삭제 아님)
 */
export async function archiveOldSessions() {
  try {
    const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await prisma.channel.updateMany({
      where: {
        tool: 'general',
        archived: false,
        lastMessageAt: { lt: threshold },
      },
      data: { archived: true },
    });
    if (result.count > 0) {
      console.log(`[archive] Archived ${result.count} old free chat sessions`);
    }
  } catch { /* ignore */ }
}

export async function brainRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', aiRateLimiter);

  // ── 파일 업로드 + AI 처리 ───────────────────────────
  app.post('/api/brain/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: '파일이 필요합니다' });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as any) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) return reply.code(400).send({ error: '빈 파일입니다' });
    if (buffer.length > 20 * 1024 * 1024) return reply.code(413).send({ error: '파일이 너무 큽니다 (최대 20MB)' });

    const { processUploadedFile } = await import('../services/file-processor.js');
    const result = await processUploadedFile(buffer, data.filename || 'upload', data.mimetype || 'application/octet-stream');

    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
    const memo = await prisma.memo.create({
      data: {
        userId,
        labId: lab?.id || undefined,
        title: `[첨부] ${result.filename}`,
        content: result.text,
        tags: ['file-upload', result.type],
        source: 'file-upload',
      },
    });

    embedAndStore(basePrismaClient, {
      sourceType: 'memo', sourceId: memo.id, labId: lab?.id || null, userId,
      title: `[첨부] ${result.filename}`, content: result.text,
      tags: ['file-upload', result.type], source: 'file-upload',
    }).catch((err: any) => console.error('[background] file-upload embedAndStore:', err.message || err));

    const actionMessages: Record<string, string> = {
      paper_discuss: `[논문] 논문이 업로드되었습니다: "${result.filename}"\n\n이 논문에 대해 질문하거나, 핵심 논문과 비교 분석을 요청할 수 있습니다.\n논문 도구를 선택하면 연구 맥락에서 더 깊은 토론이 가능합니다.`,
      document_summarize: `[문서] 문서가 업로드되었습니다: "${result.filename}"\n\n요약, 핵심 내용 추출, 또는 특정 부분에 대해 질문해주세요.`,
      import_projects: `[과제] 과제 데이터가 감지되었습니다 (${result.metadata?.rowCount || 0}건)\n\n"과제 정보로 저장해줘"라고 하면 자동으로 분류 저장합니다.`,
      import_members: `[구성원] 구성원 데이터가 감지되었습니다 (${result.metadata?.rowCount || 0}명)\n\n"구성원으로 저장해줘"라고 하면 자동으로 등록합니다.`,
      import_publications: `[논문] 논문 목록이 감지되었습니다 (${result.metadata?.rowCount || 0}편)\n\n"논문 목록으로 저장해줘"라고 하면 자동으로 등록합니다.`,
      import_calendar: `[일정] 일정 데이터가 감지되었습니다\n\n"캘린더에 등록해줘"라고 하면 확인 후 등록합니다.`,
      receipt_process: `[영수증] 영수증이 감지되었습니다\n\n회의록 양식에 필요한 정보를 자동 추출했습니다. "회의록 만들어줘"라고 하면 진행합니다.`,
      image_memo: `[이미지] 이미지가 업로드되었습니다\n\n내용을 분석했습니다. 질문하거나 "메모로 저장해줘"라고 하세요.`,
      document_review: `[문서] 문서가 업로드되었습니다: "${result.filename}"\n\n교정, 요약, 또는 특정 부분에 대해 질문해주세요.`,
      data_review: `[데이터] 데이터 파일이 업로드되었습니다 (${result.metadata?.rowCount || 0}행)\n\n어떻게 처리할지 알려주세요.`,
    };

    let similarDocs: Array<{ title: string; similarity: number; sourceId: string }> = [];
    try {
      const { findSimilarDocuments } = await import('../services/rag-engine.js');
      const similar = await findSimilarDocuments(basePrismaClient, result.text, userId, lab?.id || null);
      similarDocs = similar
        .filter(s => s.sourceId !== memo.id)
        .map(s => ({ title: s.title || '(제목 없음)', similarity: s.similarity, sourceId: s.sourceId }));
    } catch {}

    let finalMessage = actionMessages[result.suggestedAction] || `파일이 업로드되었습니다: ${result.filename}`;

    if (similarDocs.length > 0) {
      const simList = similarDocs.map(s =>
        `- "${s.title}" (유사도 ${Math.round(s.similarity * 100)}%)`
      ).join('\n');
      finalMessage += `\n\n---\n**유사한 기존 문서가 발견되었습니다:**\n${simList}\n\n기존 문서를 업데이트하려면 "업데이트해줘"라고, 별도로 보관하려면 "별도 보관"이라고 말씀해주세요.`;
    }

    return reply.send({
      success: true,
      fileId: memo.id,
      type: result.type,
      filename: result.filename,
      suggestedAction: result.suggestedAction,
      message: finalMessage,
      preview: result.text.slice(0, 500),
      structured: result.structured,
      metadata: result.metadata,
      similarDocs,
    });
  });

  // ── Chat (단일 대화 + Shadow Session) ──────
  app.post('/api/brain/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId: inputChannelId, message, fileId, newSession, stream } = chatSchema.parse(request.body);
    const userId = request.userId!;

    const sendProgress = stream
      ? (step: string) => { try { reply.raw.write(`data: ${JSON.stringify({ type: 'progress', step })}\n\n`); } catch {} }
      : (_step: string) => {};

    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sendProgress('질문을 분석하고 있습니다...');
    }

    const sendErrorAndEnd = (err: any) => {
      if (stream) {
        try {
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', error: err?.message || '처리 중 오류가 발생했습니다' })}\n\n`);
          reply.raw.end();
        } catch {}
      }
    };

    try {

    // ── 파일 컨텍스트 주입 ──────────
    let fileContext = '';
    if (fileId) {
      const fileMemo = await prisma.memo.findFirst({
        where: { id: fileId, userId, source: 'file-upload' },
      });
      if (fileMemo) {
        fileContext = `\n\n[업로드된 파일: ${fileMemo.title}]\n${fileMemo.content.slice(0, 5000)}`;
      }
    }

    // ── 단일 대화 세션 관리 ────────────────────────
    let channelId = inputChannelId;
    let isNewSession = false;

    if (newSession || !channelId) {
      if (newSession) {
        const sessionName = message.length > 30 ? message.slice(0, 27) + '...' : message;
        const newChannel = await prisma.channel.create({
          data: { userId, type: 'BRAIN', name: sessionName },
        });
        channelId = newChannel.id;
        isNewSession = true;
      } else {
        const recentChannel = await prisma.channel.findFirst({
          where: { userId, shadow: false, archived: false },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (recentChannel) {
          channelId = recentChannel.id;
        } else {
          const sessionName = message.length > 30 ? message.slice(0, 27) + '...' : message;
          const newChannel = await prisma.channel.create({
            data: { userId, type: 'BRAIN', name: sessionName },
          });
          channelId = newChannel.id;
          isNewSession = true;
        }
      }
    }

    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });

    // ── 컨텍스트 윈도우: 최근 20개 메시지 ──────
    const recentCtx = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const contextMessages = recentCtx.reverse();

    // ── 의도 분류 ──
    const recentTurns: ConversationTurn[] = contextMessages.map(m => ({
      role: m.role, content: m.content,
    }));

    const correctionCheck = detectCorrection(message, recentTurns);
    const corrections = await loadIntentCorrections(userId);

    const classified = await classifyIntent(message, recentTurns, corrections);
    let { intent, hops } = classified;
    const entities = classified.entities || {};

    sendProgress(PROGRESS_MAP[intent] || '처리하고 있습니다...');

    // 정정 처리
    if (correctionCheck.isCorrection && correctionCheck.previousUserMessage) {
      const prevClassified = await classifyIntent(correctionCheck.previousUserMessage);
      if (prevClassified.intent !== intent) {
        saveIntentCorrection(userId, {
          originalMessage: correctionCheck.previousUserMessage,
          wrongIntent: prevClassified.intent,
          correctIntent: intent,
        }).catch((err: any) => console.error('[background] saveIntentCorrection:', err.message || err));
      }
      const prevIntent = prevClassified.intent;
      if (['calendar_query', 'email_briefing', 'email_read'].includes(prevIntent) && intent === 'general_chat') {
        intent = prevIntent as Intent;
        sendProgress(PROGRESS_MAP[intent] || '다시 확인하고 있습니다...');
      }
    }

    // ── RAG 데이터 검색 ──
    let dbResult: string | null = null;
    let ragUsed = false;
    let ragResultCount = 0;

    const isActionIntent = ['save_memo', 'capture_create', 'capture_complete',
      'daily_brief', 'emerge', 'weekly_review', 'add_dict',
      'email_briefing', 'email_query', 'email_read', 'email_reply_draft',
      'calendar_query', 'calendar_create'].includes(intent);

    // ── Shadow Session: 도구 관련 intent 처리 ──
    const shadowType = determineShadowType(intent, message);
    let shadowResult: string | null = null;
    let narrativeBriefingSuccess = false;

    if (shadowType === 'email' && intent === 'email_briefing') {
      const briefingResult = await handleEmailBriefing(app, request, message, userId, sendProgress, !!stream, reply);
      shadowResult = briefingResult.result;
      narrativeBriefingSuccess = briefingResult.narrativeSuccess;
      // 실패 시 기존 메모 기반 fallback
      if (!shadowResult) {
        sendProgress('최근 브리핑 데이터를 확인하고 있습니다...');
        const toolResult = await handleToolMessage('email', message + fileContext, userId, lab, request.labId, recentTurns);
        shadowResult = toolResult.response;
      }
    } else if (shadowType === 'email' && intent === 'email_query') {
      const toolResult = await handleToolMessage('email', message + fileContext, userId, lab, request.labId, recentTurns);
      const shadowChannelId = await getOrCreateShadow(userId, 'email');
      saveShadowMessage(shadowChannelId, message, toolResult.response).catch((err: any) => console.error('[background] saveShadowMessage:', err.message || err));
      shadowResult = toolResult.response;
    } else if (shadowType === 'email' && intent === 'email_read') {
      shadowResult = await handleEmailRead(app, request, message, userId, entities, sendProgress);
    } else if (shadowType === 'email' && intent === 'email_reply_draft') {
      shadowResult = await handleEmailReplyDraft(app, request, message, userId, entities, sendProgress);
    } else if (intent === 'email_preference') {
      shadowResult = await handleEmailPreference(message, userId);
    } else if (shadowType === 'calendar' && intent === 'calendar_create') {
      shadowResult = await handleCalendarCreate(app, request, message, userId, sendProgress);
    } else if (shadowType === 'calendar') {
      const toolResult = await handleToolMessage('calendar', message + fileContext, userId, lab, request.labId, recentTurns);
      const shadowChannelId = await getOrCreateShadow(userId, 'calendar');
      saveShadowMessage(shadowChannelId, message, toolResult.response).catch((err: any) => console.error('[background] saveShadowMessage:', err.message || err));
      shadowResult = toolResult.response;
    }

    // Handle document update/replace request
    if (/업데이트|교체|대체|replace/i.test(message) && !dbResult) {
      const prevMsg = contextMessages.find((m: any) => m.role === 'assistant' && m.content?.includes('유사한 기존 문서'));
      if (prevMsg) {
        const recentUpload = await prisma.memo.findFirst({
          where: { userId, source: 'file-upload' },
          orderBy: { createdAt: 'desc' },
        });
        if (recentUpload) {
          const { findSimilarDocuments } = await import('../services/rag-engine.js');
          const similar = await findSimilarDocuments(basePrismaClient, recentUpload.content.slice(0, 1500), userId, lab?.id || null);
          const toArchive = similar.filter(s => s.sourceId !== recentUpload.id);

          let archivedCount = 0;
          for (const doc of toArchive) {
            try {
              await prisma.memo.update({
                where: { id: doc.sourceId },
                data: { source: 'archived' },
              });
              archivedCount++;
            } catch {}
          }

          if (archivedCount > 0) {
            dbResult = `기존 유사 문서 ${archivedCount}건을 보관 처리하고, 새 문서("${recentUpload.title}")로 업데이트했습니다. 보관된 문서는 삭제되지 않았으며 필요시 복구 가능합니다.`;
          }
        }
      }
    }

    if (lab && !isActionIntent) {
      if (intent === 'multi_hop' && hops && hops.length > 0) {
        dbResult = await executeMultiHopQuery(message, entities, hops, lab.id);
      }

      sendProgress('연구실 정보를 검색하고 있습니다...');
      const useRag = env.OPENAI_API_KEY && await isRagReady(basePrismaClient);

      if (useRag) {
        try {
          const searchResults = await hybridSearch(basePrismaClient, message, userId, lab.id, { limit: 10 });
          if (searchResults.length > 0) {
            const ranked = await rerank(searchResults, message, { topK: 8 });
            ragResultCount = ranked.length;
            ragUsed = true;

            const ragText = ranked.map(r => {
              const sourceLabel = { memo: '메모', member: '구성원', project: '과제', publication: '논문' }[r.sourceType] || r.sourceType;
              const metaSource = (r.metadata as any)?.source;
              const label = metaSource ? `${sourceLabel}/${metaSource}` : sourceLabel;
              return `[${r.citation}] (${label}) ${r.title || ''}\n${r.chunkText.substring(0, 500)}`;
            }).join('\n\n');

            dbResult = dbResult ? `${dbResult}\n\n${ragText}` : ragText;
          }
        } catch (err) {
          console.warn('RAG search failed, falling back to keyword:', err);
        }
      }

      // Fallback: 키워드 검색
      if (!dbResult) {
        const searchWords = message
          .replace(/[?？！!을를이가에서의로는은해줘줘요알려정보보여뭐있어내]/g, ' ')
          .split(/\s+/).filter(w => w.length > 1);

        if (searchWords.length > 0) {
          const memos = await prisma.memo.findMany({
            where: {
              OR: [{ userId }, { labId: lab.id }],
              AND: { OR: searchWords.flatMap(w => [
                { title: { contains: w, mode: 'insensitive' as const } },
                { content: { contains: w, mode: 'insensitive' as const } },
              ]) },
            },
            orderBy: { createdAt: 'desc' },
            take: 8,
          });

          if (memos.length > 0) {
            dbResult = memos.map((m, i) =>
              `${i + 1}. [${m.source || '메모'}] ${m.title || ''}\n${m.content.substring(0, 400)}`
            ).join('\n\n');
          }
        }

        if (!dbResult) {
          dbResult = await handleDbQuery(intent, entities, lab.id, userId, message);
        }
      }
    }

    // 메모 저장
    if (intent === 'save_memo' && lab) {
      const { autoTagByRules } = await import('../services/auto-tagger.js');
      const autoTags = entities.tags ? [entities.tags] : autoTagByRules(message);
      const title = message.length > 60 ? message.slice(0, 57) + '...' : message;
      const newMemo = await prisma.memo.create({
        data: {
          labId: lab.id,
          userId,
          title,
          content: message,
          source: 'chat',
          tags: autoTags,
        },
      });
      dbResult = `메모가 저장되었습니다. (태그: ${autoTags.join(', ')})`;
      embedAndStore(basePrismaClient, {
        sourceType: 'memo', sourceId: newMemo.id, labId: lab.id, userId,
        title, content: message, tags: autoTags, source: 'chat',
      }).catch((err: any) => console.error('[background] embedAndStore:', err.message || err));
    }

    // 용어 교정 등록
    if (intent === 'add_dict' && lab && entities.wrongForm && entities.correctForm) {
      await prisma.domainDict.upsert({
        where: { labId_wrongForm: { labId: lab.id, wrongForm: entities.wrongForm } },
        create: { labId: lab.id, wrongForm: entities.wrongForm, correctForm: entities.correctForm },
        update: { correctForm: entities.correctForm },
      });
      dbResult = `용어 교정 등록 완료: "${entities.wrongForm}" → "${entities.correctForm}"`;
    }

    // 캡처 인텐트 처리
    const captureContent = entities.content || message;
    if (intent === 'capture_create' && lab) {
      const { classifyCapture, typeToCategory, urgencyToPriority } = await import('../services/capture-classifier.js');
      const classification = await classifyCapture(captureContent);
      const capture = await prisma.capture.create({
        data: {
          userId,
          labId: lab.id,
          content: captureContent,
          summary: classification.summary,
          category: typeToCategory(classification.type),
          tags: classification.tags,
          priority: urgencyToPriority(classification.urgency),
          confidence: classification.confidence,
          actionDate: classification.dueDate ? new Date(classification.dueDate) : null,
          modelUsed: 'gemini-flash',
          sourceType: 'text',
          status: 'active',
          reviewed: true,
        },
      });
      const label = classification.type === 'task' ? '[완료]' : classification.type === 'idea' ? '[아이디어]' : '[메모]';
      dbResult = `${label} 캡처 저장 완료: [${classification.type}] ${classification.summary}` +
        (classification.tags.length > 0 ? `\n태그: ${classification.tags.join(', ')}` : '') +
        (classification.dueDate ? `\n마감: ${classification.dueDate.split('T')[0]}` : '');
    }

    if (intent === 'capture_list' && lab) {
      const typeFilter = entities.type ? { category: entities.type.toUpperCase() as any } : {};
      const captures = await prisma.capture.findMany({
        where: { labId: lab.id, status: 'active', ...typeFilter },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      if (captures.length === 0) {
        dbResult = '현재 활성 캡처가 없습니다.';
      } else {
        const lines = captures.map((c: any, i: number) => {
          const label = c.category === 'TASK' ? '[할일]' : c.category === 'IDEA' ? '[아이디어]' : '[메모]';
          return `${i + 1}. ${label} ${c.summary || c.content.substring(0, 40)}`;
        });
        dbResult = `캡처 목록 (${captures.length}건):\n${lines.join('\n')}`;
      }
    }

    if (intent === 'capture_complete' && lab && entities.content) {
      const capture = await prisma.capture.findFirst({
        where: {
          labId: lab.id,
          status: 'active',
          OR: [
            { content: { contains: entities.content, mode: 'insensitive' } },
            { summary: { contains: entities.content, mode: 'insensitive' } },
          ],
        },
      });
      if (capture) {
        await prisma.capture.update({
          where: { id: capture.id },
          data: { status: 'completed', completed: true, completedAt: new Date() },
        });
        dbResult = `[완료] 캡처 완료 처리: ${capture.summary || capture.content.substring(0, 40)}`;
      } else {
        dbResult = '일치하는 캡처를 찾을 수 없습니다.';
      }
    }

    // Thinking Commands
    if (intent === 'daily_brief') {
      const { dailyBrief } = await import('../services/knowledge-graph.js');
      dbResult = await dailyBrief(userId);
    } else if (intent === 'emerge') {
      const { emergeInsights } = await import('../services/knowledge-graph.js');
      dbResult = await emergeInsights(userId);
    } else if (intent === 'weekly_review') {
      const { weeklyReview } = await import('../services/knowledge-graph.js');
      dbResult = await weeklyReview(userId);
    }

    let toolResult: string | null = shadowResult || null;

    // 5층 컨텍스트 빌드
    sendProgress('이전 대화를 참고하고 있습니다...');
    const layerContext = await build5LayerContext(channelId, userId, lab?.id || null, message, intent);

    const recentMessages = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // 사용자 메시지 저장
    await prisma.message.create({
      data: { channelId, userId, role: 'user', content: message },
    });

    // AI 응답 생성
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const userInstructions = lab?.instructions ? lab.instructions : null;
    const systemPrompt = buildCoreSystemPrompt({
      responseStyle: lab?.responseStyle,
      userInstructions,
    });

    const sortedMessages = [...recentMessages].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const chatHistory = sortedMessages.map(m => ({
      role: m.role === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: m.content }],
    }));

    // ── 직접 반환 intent들 ──
    const directPassthroughIntents = ['daily_brief', 'emerge', 'weekly_review'];
    const isEmailBriefingDirect = intent === 'email_briefing' && narrativeBriefingSuccess && shadowResult;
    const skipDirectDueToCorrection = correctionCheck.isCorrection;
    const directResult = isEmailBriefingDirect ? shadowResult
      : directPassthroughIntents.includes(intent) ? (dbResult || '데이터가 아직 충분하지 않습니다. 대화, 미팅, 이메일이 쌓이면 자동으로 제공됩니다.')
      : dbResult;
    if (!skipDirectDueToCorrection && (isEmailBriefingDirect || directPassthroughIntents.includes(intent)) && directResult) {
      sendProgress('결과를 전달하고 있습니다...');
      const responseText = directResult;

      if (stream) {
        const chunkSize = 80;
        for (let i = 0; i < responseText.length; i += chunkSize) {
          const chunk = responseText.slice(i, i + chunkSize);
          try { reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: chunk })}\n\n`); } catch {}
        }
      }

      await prisma.message.create({
        data: { channelId, userId, role: 'assistant', content: responseText },
      });

      if (stream) {
        try {
          reply.raw.write(`data: ${JSON.stringify({
            type: 'done', response: responseText, channelId, intent,
            isNewSession: !inputChannelId,
          })}\n\n`);
          reply.raw.end();
        } catch {}
        return;
      }
      return reply.send({ response: responseText, channelId, intent, isNewSession: !inputChannelId });
    }

    // 사용자 콘텐츠 조합
    let userContent = message + fileContext;

    if (correctionCheck.isCorrection && correctionCheck.previousAssistantMessage) {
      userContent = `[사용자 정정] 사용자가 이전 답변의 오류를 지적하고 있습니다. 이전 답변이 틀렸음을 인정하고, 사용자의 정정 내용을 반영하여 다시 답변하세요.\n\n이전 답변 (틀린 내용 포함):\n${correctionCheck.previousAssistantMessage.substring(0, 1500)}\n\n사용자 정정:\n${userContent}`;
    }

    if (layerContext) {
      userContent = `[참고 정보]\n${layerContext}\n\n${userContent}`;
    }
    if (toolResult) {
      userContent = `${userContent}\n\n[도구 결과 — 이메일/캘린더/논문 API에서 가져온 데이터]\n${toolResult}`;
    }
    if (dbResult) {
      userContent = `${userContent}\n\n[조회 결과 — 연구실 DB 검색 결과]\n${dbResult}`;
    }

    sendProgress('답변을 준비하고 있습니다...');

    // ── 최종 응답: Claude Sonnet ──
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of sortedMessages) {
      const role = m.role === 'user' ? 'user' as const : 'assistant' as const;
      if (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === role) continue;
      anthropicMessages.push({ role, content: m.content });
    }
    if (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === 'user') {
      anthropicMessages[anthropicMessages.length - 1].content += '\n\n' + userContent;
    } else {
      anthropicMessages.push({ role: 'user', content: userContent });
    }

    let responseText = '';

    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

      if (stream) {
        const anthropicStream = anthropic.messages.stream({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: anthropicMessages,
        });

        for await (const event of anthropicStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const text = event.delta.text;
            responseText += text;
            try { reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: text })}\n\n`); } catch {}
          }
        }
      } else {
        const result = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: anthropicMessages,
        });
        const textBlock = result.content.find(b => b.type === 'text');
        responseText = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      }
      trackAICost(userId, 'claude-sonnet', COST_PER_CALL['claude-sonnet'], intent);
    } catch (sonnetErr: any) {
      console.warn('[brain] Sonnet failed, falling back to Gemini Flash:', sonnetErr.message);
      sendProgress('대체 모델로 전환 중...');

      const chat = model.startChat({
        history: chatHistory,
        systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
      });

      const geminiTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI 응답 시간이 초과되었습니다.')), 60000)
      );

      if (stream) {
        const streamResult = await Promise.race([chat.sendMessageStream(userContent), geminiTimeout]);
        for await (const chunk of streamResult.stream) {
          const text = chunk.text();
          if (text) {
            responseText += text;
            try { reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: text })}\n\n`); } catch {}
          }
        }
      } else {
        const result = await Promise.race([chat.sendMessage(userContent), geminiTimeout]);
        responseText = result.response.text();
      }
      trackAICost(userId, 'gemini-flash', COST_PER_CALL['gemini-flash'], intent);
    }

    // 할루시네이션 검증
    if (ragUsed && ragResultCount > 0) {
      const validation = validateResponse(responseText, ragResultCount > 0);
      if (!validation.isGrounded && validation.warning) {
        responseText += `\n\n[주의] ${validation.warning}`;
      }
    }

    // AI 응답 저장
    await prisma.message.create({
      data: { channelId, userId, role: 'assistant', content: responseText },
    });

    // 세션 메타 업데이트 + 자동 제목
    const msgCount = await prisma.message.count({ where: { channelId } });
    const channelUpdate: any = { messageCount: msgCount, lastMessageAt: new Date() };
    if (msgCount >= 3 && msgCount <= 5) {
      channelUpdate.name = await generateSessionTitle(contextMessages, message);
    }
    await prisma.channel.update({ where: { id: channelId }, data: channelUpdate });

    // 비동기 후처리
    maybeGenerateSummary(channelId).catch((err: any) => console.error('[background] maybeGenerateSummary:', err.message || err));
    if (lab) {
      autoExtractInfo(message, responseText, lab.id).catch((err: any) => console.error('[background] autoExtractInfo:', err.message || err));
    }

    // 자동 캡처 감지
    let autoCaptured: { type: string; summary: string } | null = null;
    if (lab && !['capture_create', 'capture_list', 'capture_complete', 'save_memo'].includes(intent)) {
      const { shouldAutoCapture, classifyCapture, typeToCategory, urgencyToPriority } = await import('../services/capture-classifier.js');
      const autoType = shouldAutoCapture(message);
      if (autoType) {
        try {
          const classification = await classifyCapture(message);
          if (classification.confidence >= 0.6) {
            await prisma.capture.create({
              data: {
                userId,
                labId: lab.id,
                content: message,
                summary: classification.summary,
                category: typeToCategory(classification.type),
                tags: classification.tags,
                priority: urgencyToPriority(classification.urgency),
                confidence: classification.confidence,
                actionDate: classification.dueDate ? new Date(classification.dueDate) : null,
                modelUsed: 'gemini-flash-auto',
                sourceType: 'text',
                status: 'active',
                reviewed: false,
              },
            });
            autoCaptured = { type: classification.type, summary: classification.summary };
            const label = classification.type === 'task' ? '[할일]' : '[아이디어]';
            const indicator = `\n\n---\n${label} ${classification.type === 'task' ? '할일' : '아이디어'} 자동 저장됨: "${classification.summary}"`;
            responseText += indicator;
            await prisma.message.updateMany({
              where: { channelId, role: 'assistant' },
              data: { content: responseText },
            });
          }
        } catch (err) {
          console.warn('Auto-capture failed:', err);
        }
      }
    }

    const payload = {
      response: responseText,
      channelId,
      intent,
      isNewSession,
      multiHop: intent === 'multi_hop',
      dbResult: dbResult ? true : false,
      autoCaptured,
    };

    if (stream) {
      reply.raw.write(`data: ${JSON.stringify({ type: 'done', ...payload })}\n\n`);
      reply.raw.end();
      return;
    }

    return payload;

    } catch (err: any) {
      if (stream) {
        sendErrorAndEnd(err);
        return;
      }
      throw err;
    }
  });

  // ── AI 비용 요약 ──────────────────────────────────
  app.get('/api/brain/cost-summary', async (request: FastifyRequest<{ Querystring: { days?: string } }>) => {
    const userId = request.userId!;
    const days = Math.min(parseInt(request.query.days || '30', 10), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await prisma.aiCostLog.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { service: true, cost: true, intent: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byService: Record<string, { calls: number; cost: number }> = {};
    const byDay: Record<string, { calls: number; cost: number }> = {};
    const byIntent: Record<string, { calls: number; cost: number }> = {};
    let totalCost = 0;

    for (const log of logs) {
      totalCost += log.cost;
      if (!byService[log.service]) byService[log.service] = { calls: 0, cost: 0 };
      byService[log.service].calls++;
      byService[log.service].cost += log.cost;
      const day = log.createdAt.toISOString().split('T')[0];
      if (!byDay[day]) byDay[day] = { calls: 0, cost: 0 };
      byDay[day].calls++;
      byDay[day].cost += log.cost;
      const intentKey = log.intent || 'unknown';
      if (!byIntent[intentKey]) byIntent[intentKey] = { calls: 0, cost: 0 };
      byIntent[intentKey].calls++;
      byIntent[intentKey].cost += log.cost;
    }

    const todayKey = new Date().toISOString().split('T')[0];
    const todayCost = byDay[todayKey]?.cost || 0;
    const todayCalls = byDay[todayKey]?.calls || 0;

    return {
      totalCost,
      totalCalls: logs.length,
      todayCost,
      todayCalls,
      days,
      byService,
      byDay,
      byIntent,
    };
  });

  // ── Channel CRUD ──────────────────────────────────
  app.get('/api/brain/channels', async (request: FastifyRequest) => {
    const channels = await prisma.channel.findMany({
      where: { userId: request.userId!, archived: false, shadow: false },
      orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
    return { data: channels };
  });

  app.post('/api/brain/channels', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createChannelSchema.parse(request.body);
    const channel = await prisma.channel.create({
      data: { userId: request.userId!, type: body.type, name: body.name },
    });
    return reply.code(201).send(channel);
  });

  app.get('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const channel = await prisma.channel.findFirst({
      where: { id: request.params.id, userId: request.userId! },
    });
    if (!channel) return [];

    return prisma.message.findMany({
      where: { channelId: request.params.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  });

  app.delete('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await prisma.channel.deleteMany({
      where: { id: request.params.id, userId: request.userId! },
    });
    return { success: true };
  });

  // ── Memo (수동 저장) ──────────────────────────────
  app.post('/api/brain/memo', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = memoSchema.parse(request.body);
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    let tags = body.tags || [];
    if (tags.length === 0) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const m = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const r = await m.generateContent(
          `다음 메모에 적절한 태그를 3~5개 생성하세요. JSON 배열로만 응답: "${body.content}"`
        );
        trackAICost(request.userId!, 'gemini-flash', COST_PER_CALL['gemini-flash']);
        const text = r.response.text().trim();
        const match = text.match(/\[.*\]/s);
        if (match) tags = JSON.parse(match[0]);
      } catch {}
    }

    const memo = await prisma.memo.create({
      data: {
        labId: lab.id,
        userId: request.userId!,
        content: body.content,
        title: body.title,
        tags,
        source: body.source,
      },
    });
    return reply.code(201).send(memo);
  });

  // ── Search ────────────────────────────────────────
  app.get('/api/brain/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const { query, type } = searchSchema.parse(request.query as any);
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    const results: any = {};

    if (type === 'all' || type === 'memo') {
      results.memos = await prisma.memo.findMany({
        where: {
          OR: [
            { labId: lab.id, shared: true },
            { userId: request.userId! },
          ],
          AND: {
            OR: [
              { content: { contains: query, mode: 'insensitive' } },
              { title: { contains: query, mode: 'insensitive' } },
              { tags: { has: query } },
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    }

    if (type === 'all' || type === 'project') {
      results.projects = await prisma.project.findMany({
        where: {
          labId: lab.id,
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { funder: { contains: query, mode: 'insensitive' } },
            { number: { contains: query, mode: 'insensitive' } },
            { pm: { contains: query, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (type === 'all' || type === 'publication') {
      results.publications = await prisma.publication.findMany({
        where: {
          labId: lab.id,
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { journal: { contains: query, mode: 'insensitive' } },
            { authors: { contains: query, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (type === 'all' || type === 'member') {
      results.members = await prisma.labMember.findMany({
        where: {
          labId: lab.id,
          active: true,
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (env.OPENAI_API_KEY) {
      try {
        const { embedding } = await generateEmbedding(query);
        results.paperChunks = await searchPapers(prisma, embedding, 5, 0.3);
      } catch {}
    }

    if (results.memos) {
      results.memos = results.memos.map((m: any) => ({
        ...m,
        computedConfidence: calculateConfidence(m),
      }));
      trackAccess('memo', results.memos.map((m: any) => m.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
    }
    if (results.projects) {
      results.projects = results.projects.map((p: any) => ({
        ...p,
        computedConfidence: calculateConfidence(p),
      }));
      trackAccess('project', results.projects.map((p: any) => p.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
    }
    if (results.publications) {
      results.publications = results.publications.map((p: any) => ({
        ...p,
        computedConfidence: calculateConfidence(p),
      }));
      trackAccess('publication', results.publications.map((p: any) => p.id)).catch((err: any) => console.error('[background] trackAccess:', err.message || err));
    }

    return results;
  });

  // ══════════════════════════════════════════════════════
  //  METAMEMORY API ENDPOINTS
  // ══════════════════════════════════════════════════════

  app.get('/api/brain/stale/:labId', async (request: FastifyRequest<{ Params: { labId: string }; Querystring: { threshold?: string } }>, reply: FastifyReply) => {
    const { labId } = request.params;
    const threshold = parseFloat((request.query as any).threshold || '0.5');

    const [memos, members, projects, pubs] = await Promise.all([
      prisma.memo.findMany({ where: { labId } }),
      prisma.labMember.findMany({ where: { labId, active: true } }),
      prisma.project.findMany({ where: { labId } }),
      prisma.publication.findMany({ where: { labId } }),
    ]);

    type StaleRecord = {
      id: string;
      type: 'memo' | 'member' | 'project' | 'publication';
      name: string;
      confidence: number;
      createdAt: string;
      lastVerified: string | null;
      lastAccessed: string | null;
      accessCount: number;
    };

    const staleRecords: StaleRecord[] = [];

    for (const m of memos) {
      const conf = calculateConfidence(m);
      if (conf < threshold) {
        staleRecords.push({
          id: m.id, type: 'memo',
          name: m.title || m.content.slice(0, 60),
          confidence: conf,
          createdAt: m.createdAt.toISOString(),
          lastVerified: m.lastVerified?.toISOString() || null,
          lastAccessed: m.lastAccessed?.toISOString() || null,
          accessCount: m.accessCount,
        });
      }
    }
    for (const m of members) {
      const conf = calculateConfidence(m);
      if (conf < threshold) {
        staleRecords.push({
          id: m.id, type: 'member',
          name: `${m.name} (${m.role})`,
          confidence: conf,
          createdAt: m.createdAt.toISOString(),
          lastVerified: m.lastVerified?.toISOString() || null,
          lastAccessed: m.lastAccessed?.toISOString() || null,
          accessCount: m.accessCount,
        });
      }
    }
    for (const p of projects) {
      const conf = calculateConfidence(p);
      if (conf < threshold) {
        staleRecords.push({
          id: p.id, type: 'project',
          name: p.name,
          confidence: conf,
          createdAt: p.createdAt.toISOString(),
          lastVerified: p.lastVerified?.toISOString() || null,
          lastAccessed: p.lastAccessed?.toISOString() || null,
          accessCount: p.accessCount,
        });
      }
    }
    for (const p of pubs) {
      const conf = calculateConfidence(p);
      if (conf < threshold) {
        staleRecords.push({
          id: p.id, type: 'publication',
          name: p.title.slice(0, 60),
          confidence: conf,
          createdAt: p.createdAt.toISOString(),
          lastVerified: p.lastVerified?.toISOString() || null,
          lastAccessed: p.lastAccessed?.toISOString() || null,
          accessCount: p.accessCount,
        });
      }
    }

    staleRecords.sort((a, b) => a.confidence - b.confidence);

    return {
      total: staleRecords.length,
      threshold,
      records: staleRecords,
    };
  });

  // ── POST /api/brain/verify/:memoryId ──
  app.post('/api/brain/verify/:memoryId', async (request: FastifyRequest<{
    Params: { memoryId: string };
    Body: { type: 'memo' | 'member' | 'project' | 'publication' };
  }>, reply: FastifyReply) => {
    const { memoryId } = request.params;
    const { type } = request.body as { type: string };

    const now = new Date();
    const updateData = {
      lastVerified: now,
      confidence: 1.0,
    };

    try {
      switch (type) {
        case 'memo':
          await prisma.memo.update({ where: { id: memoryId }, data: updateData });
          break;
        case 'member':
          await prisma.labMember.update({ where: { id: memoryId }, data: updateData });
          break;
        case 'project':
          await prisma.project.update({ where: { id: memoryId }, data: updateData });
          break;
        case 'publication':
          await prisma.publication.update({ where: { id: memoryId }, data: updateData });
          break;
        default:
          return reply.code(400).send({ error: `지원되지 않는 타입: ${type}. memo, member, project, publication 중 하나를 사용하세요.` });
      }

      return {
        success: true,
        message: '정보가 최신 확인 처리되었습니다.',
        memoryId,
        type,
        verifiedAt: now.toISOString(),
        newConfidence: 1.0,
      };
    } catch (err: any) {
      return reply.code(404).send({ error: `해당 ID의 ${type} 정보를 찾을 수 없습니다.` });
    }
  });

  // ── POST /api/brain/transcribe — Voice STT ──
  app.post('/api/brain/transcribe', async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No audio file' });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as any) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) return reply.code(400).send({ error: '빈 오디오 파일입니다' });
    if (buffer.length > 25 * 1024 * 1024) return reply.code(413).send({ error: '파일이 너무 큽니다 (최대 25MB)' });

    try {
      const { transcribeOnly } = await import('../services/voice-transcriber.js');
      const text = await transcribeOnly(buffer, data.mimetype || 'audio/webm');
      return { text };
    } catch (err: any) {
      return reply.code(500).send({ error: `STT failed: ${err.message}` });
    }
  });
}
