/**
 * 미니브레인 (Lab Memory) Routes — Claude Tool-Use 아키텍처
 *
 * POST   /api/brain/chat              → Claude tool-use 기반 대화 (intent classifier 제거)
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
import { aiRateLimiter, trackAICost, COST_PER_CALL, calculateAnthropicCost } from '../middleware/rate-limiter.js';
import { env } from '../config/env.js';
import { hybridSearch, rerank, validateResponse, isRagReady, embedAndStore } from '../services/rag-engine.js';
import { generateEmbedding, searchPapers } from '../services/embedding-service.js';
import { getGraphContextForQuery, buildGraphFromText } from '../services/knowledge-graph.js';

// ── Modularized imports ──────────────────────────────
import { buildCoreSystemPrompt } from '../prompts/core-system.js';
import { calculateConfidence, getStaleWarning, trackAccess } from '../services/metamemory.js';
import { maybeGenerateSummary, autoExtractInfo, generateSessionTitle } from '../services/session-manager.js';
import { TOOL_DEFINITIONS } from '../tools/tool-definitions.js';
import { executeToolCall } from '../tools/tool-executor.js';
import type Anthropic from '@anthropic-ai/sdk';

// ── Schemas ─────────────────────────────────────────
const chatSchema = z.object({
  channelId: z.string().optional(),
  message: z.string().min(1),
  fileId: z.string().optional(),
  fileIds: z.array(z.string()).optional(),
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
//  CONTEXT BUILDER
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

async function build5LayerContext(channelId: string, userId: string, labId: string | null, query?: string): Promise<string> {
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

  // Shadow sessions: 요약만 로드 (상세 데이터는 Claude가 tool로 직접 가져옴)
  if (shadows.length > 0) {
    const shadowResults = await Promise.all(shadows.map(async (shadow) => {
      const shadowSummary = await prisma.channelSummary.findFirst({
        where: { channelId: shadow.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!shadowSummary) return '';

      const label = shadow.shadowType === 'email' ? '이메일' : shadow.shadowType === 'calendar' ? '캘린더' : '지식';
      return `## ${label} 기록 요약\n${shadowSummary.summaryText}\n\n`;
    }));

    context += shadowResults.filter(Boolean).join('');
  }

  // L5: Graph + Vector Context (simple greetings skip)
  const simplePatterns = /^(안녕|고마워|감사|ㅎㅎ|ㅋㅋ|ok|네|응|좋아|알겠)/i;

  if (query && !simplePatterns.test(query.trim())) {
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

    // 논문 PDF 자동 감지 → Publication DB에도 등록 (비동기)
    let paperRegistered = false;
    if (result.suggestedAction === 'paper_discuss' && lab && data.mimetype === 'application/pdf') {
      paperRegistered = true;
      (async () => {
        try {
          const { GoogleGenerativeAI } = await import('@google/generative-ai');
          const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
          const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

          const metaResult = await model.generateContent({
            contents: [{ role: 'user', parts: [
              { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } },
              { text: `이 논문의 메타데이터를 추출하세요. JSON으로만 응답:\n{"title":"논문 제목","authors":"저자 목록","journal":"저널명","year":2024,"doi":"10.xxxx 또는 null","abstract":"초록 전문"}` },
            ] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
          });
          const metaText = metaResult.response.text().trim();
          const metaMatch = metaText.match(/\{[\s\S]*\}/);
          const meta = metaMatch ? JSON.parse(metaMatch[0]) : {};

          // 중복 체크
          const existing = await prisma.publication.findFirst({
            where: { labId: lab.id, title: { equals: meta.title, mode: 'insensitive' } },
          });
          if (existing) { console.log(`[brain-upload] 이미 등록된 논문: ${meta.title}`); return; }

          const pub = await prisma.publication.create({
            data: { labId: lab.id, title: meta.title || data.filename, authors: meta.authors, journal: meta.journal, year: meta.year, doi: meta.doi, abstract: meta.abstract, indexed: false },
          });

          // 벡터 임베딩
          const { chunkText, generateEmbedding, storePaperEmbeddings } = await import('../services/embedding-service.js');
          const fullResult = await model.generateContent({
            contents: [{ role: 'user', parts: [
              { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } },
              { text: '이 논문의 전체 텍스트를 추출하세요. 제목부터 References까지 모든 텍스트를 그대로 출력:' },
            ] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
          });
          const fullText = fullResult.response.text().trim();
          const chunks = chunkText(fullText);
          for (let i = 0; i < chunks.length; i++) {
            const { embedding } = await generateEmbedding(`Title: ${meta.title}\nAuthors: ${meta.authors}\nContent: ${chunks[i]}`);
            await storePaperEmbeddings(prisma, { paperId: pub.id, labId: lab.id, title: meta.title, authors: meta.authors, abstract: meta.abstract, journal: meta.journal, year: meta.year, doi: meta.doi, chunkIndex: i, chunkText: chunks[i] }, embedding);
          }
          await prisma.publication.update({ where: { id: pub.id }, data: { indexed: true } });

          // 지식 그래프
          const { buildGraphFromText } = await import('../services/knowledge-graph.js');
          await buildGraphFromText(userId, `논문 "${meta.title}" (${meta.journal || ''}, ${meta.year || ''})의 저자: ${meta.authors || ''}. 초록: ${meta.abstract || ''}`, 'paper_alert');
          console.log(`[brain-upload] 논문 자동 등록 완료: ${meta.title}`);
        } catch (err) {
          console.error('[brain-upload] 논문 자동 등록 실패:', err);
        }
      })();
    }

    const actionMessages: Record<string, string> = {
      paper_discuss: paperRegistered
        ? `[논문] "${result.filename}" — 연구실 논문 DB에 자동 등록 중입니다.\n\n이 논문에 대해 질문하거나, 핵심 논문과 비교 분석을 요청할 수 있습니다.`
        : `[논문] 논문이 업로드되었습니다: "${result.filename}"\n\n이 논문에 대해 질문하거나, 핵심 논문과 비교 분석을 요청할 수 있습니다.`,
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
      paperRegistered,
      message: finalMessage,
      preview: result.text.slice(0, 500),
      structured: result.structured,
      metadata: result.metadata,
      similarDocs,
    });
  });

  // ── Chat (Claude Tool-Use 기반) ──────
  app.post('/api/brain/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId: inputChannelId, message, fileId, fileIds, newSession, stream } = chatSchema.parse(request.body);
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
    const allFileIds = fileIds?.length ? fileIds : fileId ? [fileId] : [];
    if (allFileIds.length > 0) {
      const fileMemos = await prisma.memo.findMany({
        where: { id: { in: allFileIds }, userId, source: 'file-upload' },
      });
      for (const fileMemo of fileMemos) {
        fileContext += `\n\n[업로드된 파일: ${fileMemo.title}]\n${fileMemo.content.slice(0, 5000)}`;
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
    // 에러/실패 메시지를 컨텍스트에서 필터링 (과거 에러로 인한 도구 호출 포기 방지)
    const ERROR_PATTERNS = [
      '토큰이 만료', 'invalid_grant', 'invalid authentication', '인증이 필요',
      '연동이 필요', '접근 장애', '기술적인 문제', '조회 실패', '실패했습니다',
      'Token has been expired', 'ECONNREFUSED', 'ETIMEDOUT',
    ];
    const contextMessages = recentCtx.reverse().filter(m => {
      if (m.role !== 'assistant') return true;
      return !ERROR_PATTERNS.some(p => m.content.includes(p));
    });

    // ── 5층 컨텍스트 빌드 ──
    sendProgress('이전 대화를 참고하고 있습니다...');
    const layerContext = await build5LayerContext(channelId, userId, lab?.id || null, message);

    // 사용자 메시지 저장
    await prisma.message.create({
      data: { channelId, userId, role: 'user', content: message },
    });

    // ── Claude Tool-Use 기반 응답 생성 ──
    const userInstructions = lab?.instructions ? lab.instructions : null;
    const systemPrompt = buildCoreSystemPrompt({
      responseStyle: lab?.responseStyle,
      userInstructions,
    });

    // Anthropic 메시지 빌드
    const sortedMessages = [...contextMessages].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of sortedMessages) {
      const role = m.role === 'user' ? 'user' as const : 'assistant' as const;
      if (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === role) continue;
      anthropicMessages.push({ role, content: m.content });
    }

    // 현재 메시지에 컨텍스트 주입
    let userContent = message + fileContext;
    if (layerContext) {
      userContent = `[참고 정보 — 연구실 DB, 이전 대화, 지식그래프에서 자동 수집]\n${layerContext}\n\n${userContent}`;
    }

    if (anthropicMessages.length > 0 && anthropicMessages[anthropicMessages.length - 1].role === 'user') {
      anthropicMessages[anthropicMessages.length - 1].content += '\n\n' + userContent;
    } else {
      anthropicMessages.push({ role: 'user', content: userContent });
    }

    sendProgress('답변을 준비하고 있습니다...');

    let responseText = '';
    let usedTools: string[] = [];

    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

      const toolCtx = {
        app, request, userId, labId: lab?.id || null,
        sendProgress, stream: !!stream, reply,
      };

      // Tool-use 루프: Claude가 tool 호출을 멈출 때까지 반복
      let messages: Anthropic.MessageParam[] = anthropicMessages.map(m => ({
        role: m.role,
        content: m.content,
      }));

      const MAX_TOOL_ROUNDS = 5;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          tools: TOOL_DEFINITIONS,
          messages,
        });

        // 매 라운드 실제 토큰 기반 비용 추적
        const roundCost = calculateAnthropicCost('claude-sonnet', response.usage);
        trackAICost(userId, 'claude-sonnet', roundCost, usedTools[usedTools.length - 1] || 'general_chat');

        // 텍스트 블록 수집
        const textBlocks = response.content.filter(b => b.type === 'text');
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

        if (textBlocks.length > 0) {
          responseText += textBlocks.map(b => b.type === 'text' ? b.text : '').join('');
        }

        // tool 호출이 없으면 종료
        if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
          break;
        }

        // tool 호출 실행
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const toolBlock of toolUseBlocks) {
          if (toolBlock.type !== 'tool_use') continue;
          const toolName = toolBlock.name as any;
          const toolInput = toolBlock.input as Record<string, any>;
          usedTools.push(toolName);

          try {
            const result = await executeToolCall(toolName, toolInput, toolCtx);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: result,
            });
          } catch (err: any) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: `도구 실행 실패: ${err.message}`,
              is_error: true,
            });
          }
        }

        // 다음 라운드를 위해 메시지에 추가
        messages = [
          ...messages,
          { role: 'assistant' as const, content: response.content },
          { role: 'user' as const, content: toolResults },
        ];
      }
    } catch (sonnetErr: any) {
      console.warn('[brain] Sonnet tool-use failed, falling back to Gemini Flash:', sonnetErr.message);
      sendProgress('대체 모델로 전환 중...');

      // Gemini fallback (tool-use 없이 기본 대화)
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const chatHistory = sortedMessages.map(m => ({
        role: m.role === 'user' ? 'user' as const : 'model' as const,
        parts: [{ text: m.content }],
      }));

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
      trackAICost(userId, 'gemini-flash', COST_PER_CALL['gemini-flash'], 'fallback');
    }

    // Stream text if Sonnet was used (Gemini already streamed above)
    if (stream && usedTools.length >= 0 && responseText && !responseText.startsWith('[streamed]')) {
      const chunkSize = 80;
      for (let i = 0; i < responseText.length; i += chunkSize) {
        const chunk = responseText.slice(i, i + chunkSize);
        try { reply.raw.write(`data: ${JSON.stringify({ type: 'token', content: chunk })}\n\n`); } catch {}
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

    // 비동기 지식 그래프 관계 추출 (채팅에서 엔티티 축적)
    const graphText = `사용자: ${message}\nAI: ${responseText}`;
    if (graphText.length > 30) {
      buildGraphFromText(userId, graphText, 'chat')
        .catch((err: any) => console.error('[background] chat buildGraphFromText:', err.message || err));
    }

    const intent = usedTools[0] || 'general_chat';
    const payload = {
      response: responseText,
      channelId,
      intent,
      isNewSession,
      multiHop: usedTools.length > 1,
      dbResult: usedTools.length > 0,
      autoCaptured: null as { type: string; summary: string } | null,
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

  // ── AI 비용 보정 (Anthropic CSV 실제값 반영) ────────────
  app.post('/api/brain/cost-correction', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;

    // Anthropic 콘솔 CSV 실제 비용 (2026-04-01 ~ 04-07)
    const actualCosts: Array<{ date: string; service: string; cost: number }> = [
      { date: '2026-04-01', service: 'claude-opus', cost: 0.55 },
      { date: '2026-04-01', service: 'claude-sonnet', cost: 0.17 },
      { date: '2026-04-02', service: 'claude-sonnet', cost: 0.07 },
      { date: '2026-04-03', service: 'claude-opus', cost: 0.24 },
      { date: '2026-04-04', service: 'claude-opus', cost: 0.02 },
      { date: '2026-04-05', service: 'claude-opus', cost: 0.02 },
      { date: '2026-04-05', service: 'claude-sonnet', cost: 0.05 },
      { date: '2026-04-06', service: 'claude-sonnet', cost: 0.23 },
      { date: '2026-04-07', service: 'claude-opus', cost: 2.12 },
      { date: '2026-04-07', service: 'claude-sonnet', cost: 1.71 },
    ];

    // 날짜별·서비스별 기존 DB 비용 합산
    const existingLogs = await prisma.aiCostLog.findMany({
      where: {
        userId,
        createdAt: { gte: new Date('2026-04-01T00:00:00Z'), lte: new Date('2026-04-07T23:59:59Z') },
        service: { in: ['claude-sonnet', 'claude-opus'] },
      },
      select: { service: true, cost: true, createdAt: true },
    });

    const existingByDayService: Record<string, number> = {};
    for (const log of existingLogs) {
      const day = log.createdAt.toISOString().split('T')[0];
      const key = `${day}:${log.service}`;
      existingByDayService[key] = (existingByDayService[key] || 0) + log.cost;
    }

    // 차액 보정 레코드 삽입
    const corrections: Array<{ service: string; cost: number; date: string; diff: number }> = [];
    for (const actual of actualCosts) {
      const key = `${actual.date}:${actual.service}`;
      const existing = existingByDayService[key] || 0;
      const diff = actual.cost - existing;

      if (diff > 0.001) { // $0.001 이상 차이만 보정
        await prisma.aiCostLog.create({
          data: {
            userId,
            service: actual.service,
            cost: diff,
            intent: 'cost_correction',
            createdAt: new Date(`${actual.date}T12:00:00Z`),
          },
        });
        corrections.push({ service: actual.service, cost: actual.cost, date: actual.date, diff: +diff.toFixed(4) });
      }
    }

    return reply.send({
      success: true,
      message: `${corrections.length}건 보정 완료`,
      corrections,
      totalCorrected: +corrections.reduce((sum, c) => sum + c.diff, 0).toFixed(4),
    });
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
        results.paperChunks = await searchPapers(prisma, embedding, 5, 0.3, lab?.id);
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
