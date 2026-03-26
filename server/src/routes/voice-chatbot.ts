/**
 * Voice Chatbot API Routes
 *
 * 두 가지 보이스챗봇을 LabFlow 서버에 통합:
 * 1. Research Discussion Bot — 논문 RAG + 음성 대화
 * 2. English Voice Tutor — 실시간 발음/문법 교정
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { personas, getPersona, listPersonas } from '../config/personas.js';
import { conversationMonitor, type ToolCallLog } from '../services/conversation-monitor.js';

const CreateSessionSchema = z.object({
  personaId: z.enum(['research-bot', 'english-tutor']),
  userId: z.string().optional(),
});

const EndSessionSchema = z.object({
  sessionId: z.string().min(1),
  personaId: z.enum(['research-bot', 'english-tutor']),
  userId: z.string().optional(),
});

export async function voiceChatbotRoutes(app: FastifyInstance) {

  app.get('/api/voice/personas', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ personas: listPersonas() });
  });
  app.post('/api/voice/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = CreateSessionSchema.parse(req.body);
    const persona = getPersona(body.personaId);
    const sessionId = generateSessionId();
    conversationMonitor.startSession(sessionId, body.personaId, body.userId);

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
            voice: persona.voiceId,
            instructions: persona.systemPrompt,
            tools: body.personaId === 'research-bot' ? [
              {
                type: 'function', name: 'search_papers',
                description: 'Search research papers in the vector database',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string', description: 'Semantic search query' },
                    limit: { type: 'number', description: 'Max results', default: 5 },
                  },
                  required: ['query'],
                },
              },
              {
                type: 'function', name: 'get_paper_details',
                description: 'Get full details of a specific paper by its ID',
                parameters: {
                  type: 'object',
                  properties: { paperId: { type: 'string', description: 'Paper ID' } },
                  required: ['paperId'],
                },
              },
            ] : [
              {
                type: 'function', name: 'save_correction',
                description: 'Save a pronunciation or grammar correction',
                parameters: {
                  type: 'object',
                  properties: {
                    original: { type: 'string' }, corrected: { type: 'string' },
                    type: { type: 'string', enum: ['pronunciation', 'grammar', 'vocabulary'] },
                    explanation: { type: 'string' },
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
      } catch (err) { console.error('[Voice] Failed to get ephemeral token:', err); }
    }

    return reply.send({
      sessionId,
      persona: { id: persona.id, name: persona.name, nameKo: persona.nameKo, voiceId: persona.voiceId, toolAnnouncements: persona.toolAnnouncements },
      ephemeralToken,
      config: { model: 'gpt-4o-realtime-preview-2025-06-03', wsUrl: 'wss://api.openai.com/v1/realtime' },
    });
  });
  app.post('/api/voice/session/end', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = EndSessionSchema.parse(req.body);
    const { summary, turns } = conversationMonitor.endSession(body.sessionId, body.personaId, body.userId);
    return reply.send({ summary, turnsCount: turns.length });
  });

  app.post('/api/voice/search-papers', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ sessionId: z.string(), query: z.string().min(1), limit: z.number().default(5) }).parse(req.body);
    const startTime = Date.now();
    try {
      const results = { papers: [], query: body.query, totalResults: 0 };
      conversationMonitor.logToolCall(body.sessionId, {
        toolName: 'search_papers', input: { query: body.query, limit: body.limit },
        output: results, durationMs: Date.now() - startTime, success: true,
      });
      return reply.send(results);
    } catch (err) {
      conversationMonitor.logToolCall(body.sessionId, {
        toolName: 'search_papers', input: { query: body.query, limit: body.limit },
        durationMs: Date.now() - startTime, success: false, error: (err as Error).message,
      });
      return reply.code(500).send({ error: 'Paper search failed' });
    }
  });

  app.post('/api/voice/save-correction', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({
      sessionId: z.string(), original: z.string(), corrected: z.string(),
      type: z.enum(['pronunciation', 'grammar', 'vocabulary']), explanation: z.string().optional(),
    }).parse(req.body);
    conversationMonitor.logToolCall(body.sessionId, { toolName: 'save_correction', input: body, durationMs: 0, success: true });
    return reply.send({ saved: true });
  });

  app.get('/api/voice/corrections/:userId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId } = req.params as { userId: string };
    return reply.send({ corrections: [], userId });
  });
}

function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `voice-${timestamp}-${random}`;
}
