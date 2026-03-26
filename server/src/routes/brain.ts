/**
 * 미니브레인 (Lab Memory) Routes — 3층 기억 구조 + 의도 분류 + DB 조회
 *
 * POST   /api/brain/chat              → 미니브레인 대화 (3층 기억 + 의도 분류)
 * GET    /api/brain/channels           → 사용자 채널 목록
 * POST   /api/brain/channels           → 새 채널 생성
 * GET    /api/brain/channels/:id       → 채널 메시지 목록
 * DELETE /api/brain/channels/:id       → 채널 삭제
 * POST   /api/brain/memo               → 메모 저장 (수동)
 * GET    /api/brain/search             → Lab Memory 자연어 검색
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { generateEmbedding, searchPapers } from '../services/embedding-service.js';

// ── Schemas ─────────────────────────────────────────
const chatSchema = z.object({
  channelId: z.string().optional(), // 없으면 기본 BRAIN 채널 자동 생성
  message: z.string().min(1),
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

// ── Intent classification using Gemini ──────────────
type Intent = 'query_project' | 'query_publication' | 'query_member' | 'query_meeting' | 'save_memo' | 'search_memory' | 'general_chat' | 'add_dict';

async function classifyIntent(message: string): Promise<{ intent: Intent; entities: Record<string, string> }> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `사용자 메시지의 의도를 분류하세요. JSON으로만 응답하세요.

의도 목록:
- query_project: 과제 관련 질문 (사사 문구, PM, 기간 등)
- query_publication: 논문 관련 질문 (논문 수, 저널, DOI 등)
- query_member: 구성원 관련 질문 (연락처, 역할 등)
- query_meeting: 미팅 관련 질문 (지난 미팅, 논의 내용 등)
- save_memo: 메모/기억 저장 요청 ("기억해", "저장해", "메모해")
- search_memory: 과거 저장된 정보 검색 ("뭐였지", "찾아줘")
- add_dict: 용어 교정 등록 ("이건 ~라고 해", "~는 ~야")
- general_chat: 일반 대화

사용자 메시지: "${message}"

응답 형식: {"intent": "...", "entities": {"key": "value"}}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const match = text.match(/\{.*\}/s);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    console.warn('Intent classification failed:', err);
  }
  return { intent: 'general_chat', entities: {} };
}

// ── DB Query handlers based on intent ────────────────
async function handleDbQuery(intent: Intent, entities: Record<string, string>, labId: string): Promise<string | null> {
  switch (intent) {
    case 'query_project': {
      const projects = await prisma.project.findMany({ where: { labId } });
      if (projects.length === 0) return '등록된 과제가 없습니다. /api/lab/projects에서 추가해주세요.';

      const keyword = entities.projectName || entities.query || '';
      if (keyword) {
        const matched = projects.filter(p =>
          p.name.includes(keyword) || p.funder?.includes(keyword) || p.number?.includes(keyword)
        );
        if (matched.length > 0) {
          return matched.map(p =>
            `📋 **${p.name}**\n  과제번호: ${p.number || '미등록'}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}\n  PI: ${p.pi || '미등록'}\n  사사문구: ${p.acknowledgment || '미등록'}`
          ).join('\n\n');
        }
      }
      return projects.map(p => `• ${p.name} (${p.funder || '지원기관 미등록'}) [${p.status}]`).join('\n');
    }

    case 'query_publication': {
      const pubs = await prisma.publication.findMany({ where: { labId }, orderBy: { year: 'desc' } });
      if (pubs.length === 0) return '등록된 논문이 없습니다.';

      const keyword = entities.query || '';
      if (keyword) {
        const matched = pubs.filter(p =>
          p.title.toLowerCase().includes(keyword.toLowerCase()) ||
          p.journal?.toLowerCase().includes(keyword.toLowerCase())
        );
        if (matched.length > 0) {
          return matched.map(p => `📄 ${p.title}\n  ${p.journal || ''} (${p.year || ''})\n  DOI: ${p.doi || '미등록'}`).join('\n\n');
        }
      }
      return `총 ${pubs.length}편의 논문이 등록되어 있습니다.\n\n` +
        pubs.slice(0, 10).map(p => `• ${p.title} (${p.journal || ''}, ${p.year || ''})`).join('\n');
    }

    case 'query_member': {
      const members = await prisma.labMember.findMany({ where: { labId, active: true } });
      if (members.length === 0) return '등록된 구성원이 없습니다.';

      const name = entities.name || entities.query || '';
      if (name) {
        const matched = members.filter(m => m.name.includes(name));
        if (matched.length > 0) {
          return matched.map(m =>
            `👤 **${m.name}** (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`
          ).join('\n\n');
        }
        return `"${name}"에 해당하는 구성원을 찾지 못했습니다. 등록된 정보가 없습니다. 추가하시겠습니까?`;
      }
      return members.map(m => `• ${m.name} (${m.role}) — ${m.email || '이메일 미등록'}`).join('\n');
    }

    case 'query_meeting': {
      const meetings = await prisma.meeting.findMany({
        where: { userId: labId }, // TODO: proper labId linking
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (meetings.length === 0) return '저장된 미팅 기록이 없습니다.';
      return meetings.map(m =>
        `🎙️ **${m.title}** (${m.createdAt.toLocaleDateString('ko-KR')})\n  ${m.summary?.slice(0, 200) || '요약 없음'}...`
      ).join('\n\n');
    }

    default:
      return null;
  }
}

// ── Build 3-layer context for AI ─────────────────────
async function build3LayerContext(channelId: string, labId: string | null): Promise<string> {
  let context = '';

  // Layer 2: Session summaries (이전 대화 요약)
  const summaries = await prisma.channelSummary.findMany({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  if (summaries.length > 0) {
    context += '## 이전 대화 요약\n';
    context += summaries.map(s => s.summaryText).join('\n---\n');
    context += '\n\n';
  }

  // Layer 3: Lab Memory (영구 기억 — Lab Profile 요약)
  if (labId) {
    const lab = await prisma.lab.findUnique({
      where: { id: labId },
      include: {
        members: { where: { active: true }, take: 20 },
        projects: { where: { status: 'active' }, take: 10 },
        domainDict: { take: 50 },
      },
    });

    if (lab) {
      context += '## Lab Profile (영구 기억)\n';
      context += `연구실: ${lab.name}\n`;
      context += `소속: ${lab.institution || '미등록'} ${lab.department || ''}\n`;
      context += `연구 분야: ${lab.researchFields.join(', ') || '미등록'}\n`;
      if (lab.members.length > 0) {
        context += `구성원 (${lab.members.length}명): ${lab.members.map(m => `${m.name}(${m.role})`).join(', ')}\n`;
      }
      if (lab.projects.length > 0) {
        context += `진행 과제: ${lab.projects.map(p => p.name).join(', ')}\n`;
      }
      if (lab.domainDict.length > 0) {
        context += `전문용어 사전: ${lab.domainDict.slice(0, 20).map(d => `${d.wrongForm}→${d.correctForm}`).join(', ')}\n`;
      }
      context += '\n';
    }
  }

  return context;
}

// ── Generate session summary when messages exceed threshold ──
async function maybeGenerateSummary(channelId: string): Promise<void> {
  const messageCount = await prisma.message.count({ where: { channelId } });
  if (messageCount < 30) return; // 30개 미만이면 패스

  // 최신 요약 이후 메시지 수 확인
  const lastSummary = await prisma.channelSummary.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
  });

  const newMessages = await prisma.message.findMany({
    where: {
      channelId,
      createdAt: lastSummary ? { gt: lastSummary.createdAt } : undefined,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (newMessages.length < 20) return; // 새 메시지 20개 미만이면 패스

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const conversationText = newMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    const result = await model.generateContent(
      `다음 대화를 간결하게 요약하세요. 핵심 정보(결정사항, 질문, 답변)를 중심으로 200단어 이내로:\n\n${conversationText}`
    );

    await prisma.channelSummary.create({
      data: {
        channelId,
        summaryText: result.response.text(),
        messageRange: `${newMessages[0].id} ~ ${newMessages[newMessages.length - 1].id}`,
      },
    });
  } catch (err) {
    console.warn('Session summary generation failed:', err);
  }
}

// ── Extract and save info from chat (자동 축적) ──────
async function autoExtractInfo(message: string, response: string, labId: string): Promise<void> {
  // 대화에서 연구실 정보 자동 추출 (비동기로 처리)
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `다음 대화에서 연구실 관련 정보가 새로 언급되었는지 확인하세요.
추출할 정보: 과제-논문 연결, 새 용어, 새 인원 정보, 새 과제 정보
새 정보가 없으면 빈 배열을 반환하세요.

사용자: ${message}
AI응답: ${response}

JSON 배열로 응답: [{"type": "dict"|"memo"|"project_link", "data": {...}}]
새 정보 없으면: []`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const match = text.match(/\[.*\]/s);
    if (match) {
      const items = JSON.parse(match[0]);
      for (const item of items) {
        if (item.type === 'dict' && item.data?.wrongForm && item.data?.correctForm) {
          await prisma.domainDict.upsert({
            where: { labId_wrongForm: { labId, wrongForm: item.data.wrongForm } },
            create: { labId, wrongForm: item.data.wrongForm, correctForm: item.data.correctForm, autoAdded: true },
            update: { correctForm: item.data.correctForm },
          }).catch(() => {});
        }
      }
    }
  } catch {
    // 자동 추출 실패는 무시
  }
}

// ── Routes ───────────────────────────────────────────
export async function brainRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── Chat (3층 기억 구조) ──────────────────────────
  app.post('/api/brain/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId: inputChannelId, message } = chatSchema.parse(request.body);
    const userId = request.userId!;

    // 채널 가져오기 또는 생성
    let channelId = inputChannelId;
    if (!channelId) {
      let defaultChannel = await prisma.channel.findFirst({
        where: { userId, type: 'BRAIN' },
        orderBy: { createdAt: 'desc' },
      });
      if (!defaultChannel) {
        defaultChannel = await prisma.channel.create({
          data: { userId, type: 'BRAIN', name: '미니브레인' },
        });
      }
      channelId = defaultChannel.id;
    }

    // Lab 정보 가져오기
    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });

    // 1. 의도 분류
    const { intent, entities } = await classifyIntent(message);

    // 2. DB 조회 (할루시네이션 차단 — DB에 있는 것만 답변)
    let dbResult: string | null = null;
    if (lab && ['query_project', 'query_publication', 'query_member', 'query_meeting'].includes(intent)) {
      dbResult = await handleDbQuery(intent, entities, lab.id);
    }

    // 3. 메모 저장 요청 처리
    if (intent === 'save_memo' && lab) {
      await prisma.memo.create({
        data: {
          labId: lab.id,
          userId,
          content: message,
          source: 'chat',
          tags: entities.tags ? [entities.tags] : [],
        },
      });
    }

    // 4. 용어 교정 등록
    if (intent === 'add_dict' && lab && entities.wrongForm && entities.correctForm) {
      await prisma.domainDict.upsert({
        where: { labId_wrongForm: { labId: lab.id, wrongForm: entities.wrongForm } },
        create: { labId: lab.id, wrongForm: entities.wrongForm, correctForm: entities.correctForm },
        update: { correctForm: entities.correctForm },
      });
    }

    // 5. 3층 컨텍스트 빌드
    const layerContext = await build3LayerContext(channelId, lab?.id || null);

    // Layer 1: 최근 메시지 20개
    const recentMessages = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // 6. 사용자 메시지 저장
    await prisma.message.create({
      data: { channelId, role: 'user', content: message },
    });

    // 7. AI 응답 생성
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const systemPrompt = `당신은 연구실 AI 비서 "LabFlow 미니브레인"입니다.
${lab?.responseStyle === 'casual' ? '친근하고 캐주얼한 어조로 답변하세요.' : '정중하고 전문적인 어조로 답변하세요.'}

핵심 규칙:
1. DB에 등록된 정보만 답변합니다. 추측하지 마세요.
2. 정보가 없으면 "등록된 정보가 없습니다. 추가하시겠습니까?"로 응답하세요.
3. 대화 중 새로운 연구실 정보가 언급되면 기억합니다.

${layerContext}`;

    const chatHistory = recentMessages.reverse().map(m => ({
      role: m.role === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: m.content }],
    }));

    // DB 조회 결과가 있으면 컨텍스트에 추가
    let userContent = message;
    if (dbResult) {
      userContent = `${message}\n\n[DB 조회 결과]\n${dbResult}`;
    }

    const chat = model.startChat({
      history: chatHistory,
      systemInstruction: systemPrompt,
    });

    const result = await chat.sendMessage(userContent);
    const responseText = result.response.text();

    // 8. AI 응답 저장
    await prisma.message.create({
      data: { channelId, role: 'assistant', content: responseText },
    });

    // 9. 세션 요약 트리거 (비동기)
    maybeGenerateSummary(channelId).catch(() => {});

    // 10. 자동 정보 추출 (비동기)
    if (lab) {
      autoExtractInfo(message, responseText, lab.id).catch(() => {});
    }

    return {
      response: responseText,
      channelId,
      intent,
      dbResult: dbResult ? true : false,
    };
  });

  // ── Channel CRUD ──────────────────────────────────
  app.get('/api/brain/channels', async (request: FastifyRequest) => {
    return prisma.channel.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { messages: true } },
      },
    });
  });

  app.post('/api/brain/channels', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createChannelSchema.parse(request.body);
    const channel = await prisma.channel.create({
      data: { userId: request.userId!, type: body.type, name: body.name },
    });
    return reply.code(201).send(channel);
  });

  app.get('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    const messages = await prisma.message.findMany({
      where: { channelId: request.params.id },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    return messages;
  });

  app.delete('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    // 채널과 메시지 삭제하지만, Lab Memory (Layer 3)는 유지됨
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

    // AI로 태그 자동 생성
    let tags = body.tags || [];
    if (tags.length === 0) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent(
          `다음 메모에 적절한 태그를 3~5개 생성하세요. JSON 배열로만 응답: "${body.content}"`
        );
        const text = result.response.text().trim();
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

  // ── Search (Lab Memory 자연어 검색) ────────────────
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
          labId: lab.id,
          OR: [
            { content: { contains: query, mode: 'insensitive' } },
            { title: { contains: query, mode: 'insensitive' } },
            { tags: { has: query } },
          ],
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

    // pgvector 검색 (논문 임베딩이 있는 경우)
    if (env.OPENAI_API_KEY) {
      try {
        const { embedding } = await generateEmbedding(query);
        results.paperChunks = await searchPapers(prisma, embedding, 5, 0.3);
      } catch {}
    }

    return results;
  });
}
