/**
 * Voice Chatbot API Routes
 *
 * 두 가지 보이스챗봇을 LabFlow 서버에 통합:
 * 1. Research Discussion Bot — 논문 RAG + 음성 대화
 * 2. English Voice Tutor — 실시간 발음/문법 교정
 *
 * 하이브리드 접근법: 기존 프로토타입 + LangChain 레포에서 차용한 3가지 개선사항
 * - 대화 모니터링 (Opik 스타일)
 * - 페르소나 시스템 (YAML → TS config)
 * - Tool execution 안내 음성
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { personas, getPersona, listPersonas, listVoices, VOICE_OPTIONS } from '../config/personas.js';
import { conversationMonitor, type ToolCallLog } from '../services/conversation-monitor.js';
import { prisma } from '../config/prisma.js';

// ── 스키마 정의 ────────────────────────────────────

const validVoiceIds = VOICE_OPTIONS.map(v => v.id) as [string, ...string[]];

const CreateSessionSchema = z.object({
  personaId: z.enum(['research-bot', 'english-tutor']),
  voiceId: z.enum(validVoiceIds).optional(), // 사용자 선택 음성 (없으면 페르소나 기본값)
  userId: z.string().optional(),
});

const ChatMessageSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
  personaId: z.enum(['research-bot', 'english-tutor']),
});

const EndSessionSchema = z.object({
  sessionId: z.string().min(1),
  personaId: z.enum(['research-bot', 'english-tutor']),
  userId: z.string().optional(),
});

// ── 라우트 등록 ────────────────────────────────────

export async function voiceChatbotRoutes(app: FastifyInstance) {

  /**
   * GET /api/voice/personas — 사용 가능한 페르소나 목록 (추천 음성 포함)
   */
  app.get('/api/voice/personas', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      personas: listPersonas(),
    });
  });

  /**
   * GET /api/voice/voices — 사용 가능한 전체 음성 목록
   */
  app.get('/api/voice/voices', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      voices: listVoices(),
    });
  });

  /**
   * POST /api/voice/session — 새 대화 세션 시작
   * WebRTC/WebSocket 연결을 위한 토큰 및 설정 반환
   */
  app.post('/api/voice/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = CreateSessionSchema.parse(req.body);
    const persona = getPersona(body.personaId);
    const sessionId = generateSessionId();

    // 음성 결정: 사용자 선택 > 페르소나 기본값
    const selectedVoiceId = body.voiceId || persona.defaultVoiceId;

    // 도메인 사전에서 Whisper 커스텀 어휘 로드
    let whisperPrompt = '';
    try {
      const userId = body.userId || 'dev-user-001';
      const lab = await prisma.lab.findFirst({
        where: { owner: { id: userId } },
        include: { domainDict: { take: 100 } },
      }).catch(() => null);

      if (lab && lab.domainDict.length > 0) {
        // Whisper prompt: 전문용어 목록을 쉼표로 나열하면 인식률 향상
        const terms = lab.domainDict.map(d => d.correctForm);
        whisperPrompt = `Specialized vocabulary: ${terms.join(', ')}. Lab: ${lab.name}.`;
      }
    } catch {
      // 사전 로드 실패해도 세션 생성은 진행
    }

    // 모니터링 시작
    conversationMonitor.startSession(sessionId, body.personaId, body.userId);

    // OpenAI Realtime API 임시 토큰 생성
    let ephemeralToken: string | null = null;
    if (env.OPENAI_API_KEY) {
      try {
        const tokenResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-realtime-preview-2025-06-03',
            voice: selectedVoiceId,
            instructions: persona.systemPrompt + (whisperPrompt ? `\n\n${whisperPrompt}` : ''),
            tools: body.personaId === 'research-bot' ? [
              {
                type: 'function',
                name: 'search_papers',
                description: 'Search research papers in the vector database by semantic query',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'Semantic search query for papers' },
                    limit: { type: 'number', description: 'Max results', default: 5 },
                  },
                  required: ['query'],
                },
              },
              {
                type: 'function',
                name: 'get_paper_details',
                description: 'Get full details of a specific paper by its ID',
                parameters: {
                  type: 'object',
                  properties: {
                    paperId: { type: 'string', description: 'Paper ID from search results' },
                  },
                  required: ['paperId'],
                },
              },
            ] : [
              {
                type: 'function',
                name: 'save_correction',
                description: 'Save a pronunciation or grammar correction for review',
                parameters: {
                  type: 'object',
                  properties: {
                    original: { type: 'string', description: 'What the student said' },
                    corrected: { type: 'string', description: 'The correct version' },
                    type: { type: 'string', enum: ['pronunciation', 'grammar', 'vocabulary'] },
                    explanation: { type: 'string', description: 'Brief explanation' },
                  },
                  required: ['original', 'corrected', 'type'],
                },
              },
            ],
            input_audio_transcription: { model: 'whisper-1' },
            turn_detection: { type: 'server_vad' },
          }),
        });

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json() as { client_secret?: { value?: string } };
          ephemeralToken = tokenData.client_secret?.value || null;
        }
      } catch (err) {
        console.error('[Voice] Failed to get ephemeral token:', err);
      }
    }

    return reply.send({
      sessionId,
      persona: {
        id: persona.id,
        name: persona.name,
        nameKo: persona.nameKo,
        voiceId: selectedVoiceId,
        toolAnnouncements: persona.toolAnnouncements,
      },
      ephemeralToken,
      config: {
        model: 'gpt-4o-realtime-preview-2025-06-03',
        wsUrl: 'wss://api.openai.com/v1/realtime',
      },
    });
  });

  /**
   * POST /api/voice/end-session — 대화 세션 종료 및 요약 저장
   * (기존 /api/voice/session/end에서 변경: POST /api/voice/session에 먼저 매칭되는 충돌 해소)
   */
  app.post('/api/voice/end-session', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = EndSessionSchema.parse(req.body);
    const { summary, turns } = conversationMonitor.endSession(
      body.sessionId, body.personaId, body.userId
    );

    // TODO: Supabase에 세션 요약 및 턴 데이터 저장
    // await saveSessionToSupabase(summary, turns);

    return reply.send({
      summary,
      turnsCount: turns.length,
    });
  });

  /**
   * POST /api/voice/search-papers — RAG 논문 검색 (Research Bot용)
   * Tool execution 안내 음성을 위해 별도 엔드포인트
   */
  app.post('/api/voice/search-papers', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      sessionId: z.string(),
      query: z.string().min(1),
      limit: z.number().default(5),
      threshold: z.number().min(0).max(1).default(0.3),
    }).parse(req.body);

    const startTime = Date.now();

    try {
      // TODO: OpenAI embedding → Supabase pgvector RPC 연결
      // 1. const embedding = await openai.embeddings.create({ model: 'text-embedding-3-small', input: body.query });
      // 2. const papers = await prisma.$queryRaw`SELECT * FROM search_papers(${embedding}::vector, ${body.limit}, ${body.threshold})`;

      // 임시 mock 결과 (pgvector 연결 전)
      const results = {
        papers: [],
        query: body.query,
        threshold: body.threshold,
        totalResults: 0,
      };

      const toolCall: ToolCallLog = {
        toolName: 'search_papers',
        input: { query: body.query, limit: body.limit },
        output: results,
        durationMs: Date.now() - startTime,
        success: true,
      };
      conversationMonitor.logToolCall(body.sessionId, toolCall);

      return reply.send(results);
    } catch (err) {
      const toolCall: ToolCallLog = {
        toolName: 'search_papers',
        input: { query: body.query, limit: body.limit },
        durationMs: Date.now() - startTime,
        success: false,
        error: (err as Error).message,
      };
      conversationMonitor.logToolCall(body.sessionId, toolCall);

      return reply.code(500).send({ error: 'Paper search failed' });
    }
  });

  /**
   * POST /api/voice/save-correction — 교정 기록 저장 (English Tutor용)
   */
  app.post('/api/voice/save-correction', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      sessionId: z.string(),
      original: z.string(),
      corrected: z.string(),
      type: z.enum(['pronunciation', 'grammar', 'vocabulary']),
      explanation: z.string().optional(),
    }).parse(req.body);

    // TODO: Supabase에 교정 기록 저장
    // await saveCorrectionToSupabase(body);

    conversationMonitor.logToolCall(body.sessionId, {
      toolName: 'save_correction',
      input: body,
      durationMs: 0,
      success: true,
    });

    return reply.send({ saved: true });
  });

  /**
   * GET /api/voice/corrections/:userId — 특정 사용자의 교정 히스토리
   */
  app.get('/api/voice/corrections/:userId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId } = req.params as { userId: string };

    // TODO: Supabase에서 교정 히스토리 조회
    return reply.send({
      corrections: [],
      userId,
    });
  });
}

// ── 유틸리티 ────────────────────────────────────────

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `voice-${timestamp}-${random}`;
}
