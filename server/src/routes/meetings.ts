/**
 * 회의 노트 API 라우트 — 2단계 AI 파이프라인
 *
 * Step 1: Gemini 2.5 Flash — 오디오 → 정제된 텍스트 전사 (STT)
 * Step 2: Claude Sonnet — 오탈자 교정 + 구조화 요약 (📋 안건 / 📝 논의 / ✅ 액션 / 📌 다음)
 *
 * POST   /api/meetings              — 음성 녹음으로 회의 생성
 * GET    /api/meetings              — 회의 목록 조회
 * GET    /api/meetings/:id          — 단일 회의 조회
 * PATCH  /api/meetings/:id          — 회의 수정
 * DELETE /api/meetings/:id          — 회의 삭제
 * POST   /api/meetings/transcribe   — 음성 전사만 (저장 없이)
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { buildGraphFromText } from '../services/knowledge-graph.js';

// ── AI 클라이언트 ──────────────────────────────────────
const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

function createAnthropicClient(): Anthropic | null {
  if (!env.ANTHROPIC_API_KEY) {
    console.warn('⚠️ ANTHROPIC_API_KEY 미설정 — 회의 요약에 Gemini fallback 사용');
    return null;
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// ── Zod 스키마 ──────────────────────────────────────
const updateMeetingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  actionItems: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
});

// ── 교정 사전 (전문 용어 / 기관명) ──────────────────────
const CORRECTION_DICT = `
## 교정 사전 (오탈자 교정 시 참고)
- 연세대학교, 연대, 연세대 → 연세대학교
- BLISS Lab, 블리스랩, 블리스 랩 → BLISS Lab
- 링크솔루텍, 링크 솔루텍 → 링크솔루텍
- PCB → PCB (인쇄회로기판)
- 하이드로겔, 하이드로 겔 → 하이드로겔
- 바이오센서, 바이오 센서 → 바이오센서
- PDMS → PDMS (폴리디메틸실록산)
- OLED → OLED
- 리소그래피, 리소 그래피 → 리소그래피
- SOP → SOP (Standard Operating Procedure)
- PI → PI (폴리이미드)
- ITO → ITO (인듐주석산화물)
- TFT → TFT (박막 트랜지스터)
`.trim();

// ── Step 1: Gemini STT (오디오 → 정제 텍스트) ──────────
const GEMINI_STT_PROMPT = `당신은 연구 미팅 오디오를 전사하는 전문 전사자입니다.

다음 규칙을 따르세요:
1. 오디오의 모든 내용을 한국어 텍스트로 정확하게 전사
2. 필러 단어 제거: "음...", "어...", "그래서...", "이제..." 등
3. 반복 발언 정리: 같은 말을 되풀이한 경우 한 번만 기록
4. 문장 단위로 자연스럽게 정리 (존댓말/반말 유지)
5. 전문 용어는 원래 발음에 가장 가까운 표기로 작성

오늘 날짜: ${new Date().toISOString().split('T')[0]}

전사된 텍스트만 출력하세요. JSON이나 다른 형식 없이 순수 텍스트만:`;

async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<string> {
  const result = await geminiModel.generateContent({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: audioBuffer.toString('base64'),
              mimeType,
            },
          },
          { text: GEMINI_STT_PROMPT },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  });

  const response = result.response.text().trim();
  return response;
}

// ── Step 2: Sonnet 구조화 요약 ──────────────────────────
interface MeetingSummaryResult {
  title: string;
  agenda: string[];
  discussions: Array<{ topic: string; content: string }>;
  actionItems: string[];
  nextSteps: string[];
  correctedTranscription: string;
}

async function summarizeWithSonnet(
  rawTranscription: string,
): Promise<MeetingSummaryResult> {
  const anthropic = createAnthropicClient();

  if (!anthropic) {
    // Gemini fallback (기존 방식)
    return fallbackSummarize(rawTranscription);
  }

  const systemPrompt = `당신은 연구 미팅 전사록을 분석하여 구조화된 회의록을 작성하는 전문 에디터입니다.

## 작업 순서
1. **오탈자 교정**: 전사 과정에서 발생한 오인식을 교정 사전을 참고하여 수정
2. **개인명 제거**: 특정 인물의 이름이 언급된 경우, 직함/역할로 대체 (예: "교수님", "팀원")
3. **구조화 요약**: 아래 형식으로 정리

${CORRECTION_DICT}

## 출력 형식 (반드시 JSON으로만 응답)
{
  "title": "회의 제목 (20자 이내, 핵심 주제 반영)",
  "agenda": ["안건1", "안건2"],
  "discussions": [
    { "topic": "소주제1", "content": "논의 내용 요약 (2-3문장)" },
    { "topic": "소주제2", "content": "논의 내용 요약" }
  ],
  "actionItems": ["담당자/역할: 구체적인 할 일 + 기한(있으면)"],
  "nextSteps": ["다음에 해야 할 일 1", "다음에 해야 할 일 2"],
  "correctedTranscription": "교정된 전사 텍스트 전문"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      temperature: 0.1,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `다음 회의 전사록을 분석하여 구조화된 회의록을 JSON으로 작성하세요:\n\n${rawTranscription}`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No text in Sonnet response');

    const jsonMatch = textBlock.text.trim().match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Sonnet summary response');

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      title: String(parsed.title || '제목 없음').substring(0, 200),
      agenda: Array.isArray(parsed.agenda) ? parsed.agenda.map(String) : [],
      discussions: Array.isArray(parsed.discussions)
        ? parsed.discussions.map((d: any) => ({
            topic: String(d.topic || ''),
            content: String(d.content || ''),
          }))
        : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String) : [],
      correctedTranscription: String(parsed.correctedTranscription || rawTranscription),
    };
  } catch (error) {
    console.warn('⚠️ Sonnet 회의 요약 실패, fallback 사용:', error);
    return fallbackSummarize(rawTranscription);
  }
}

// ── Gemini Fallback (Sonnet 미설정 시) ──────────────────
async function fallbackSummarize(transcription: string): Promise<MeetingSummaryResult> {
  const prompt = `다음 회의 전사록을 분석하여 JSON으로 요약하세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "title": "회의 제목 (20자 이내)",
  "agenda": ["안건1", "안건2"],
  "discussions": [{ "topic": "소주제", "content": "요약" }],
  "actionItems": ["액션 아이템"],
  "nextSteps": ["다음 할 일"]
}

전사록:
${transcription}`;

  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    });

    const response = result.response.text().trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON from Gemini fallback');
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      title: String(parsed.title || '제목 없음').substring(0, 200),
      agenda: Array.isArray(parsed.agenda) ? parsed.agenda.map(String) : [],
      discussions: Array.isArray(parsed.discussions)
        ? parsed.discussions.map((d: any) => ({ topic: String(d.topic || ''), content: String(d.content || '') }))
        : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(String) : [],
      nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps.map(String) : [],
      correctedTranscription: transcription,
    };
  } catch {
    return {
      title: '회의 기록',
      agenda: [],
      discussions: [],
      actionItems: [],
      nextSteps: [],
      correctedTranscription: transcription,
    };
  }
}

// ── 2단계 통합 파이프라인 ──────────────────────────────
interface MeetingPipelineResult {
  transcription: string;  // 교정된 전사
  title: string;
  summary: string;        // 구조화 요약 (JSON 문자열)
  agenda: string[];
  discussions: Array<{ topic: string; content: string }>;
  actionItems: string[];
  nextSteps: string[];
  modelUsed: string;
}

async function processMeetingAudio(
  audioBuffer: Buffer,
  mimeType: string = 'audio/webm',
): Promise<MeetingPipelineResult> {
  // Step 1: Gemini STT
  const rawTranscription = await transcribeAudio(audioBuffer, mimeType);

  if (!rawTranscription || rawTranscription.length < 10) {
    throw new Error('음성을 인식할 수 없습니다. 다시 시도해주세요.');
  }

  // Step 2: Sonnet 교정 + 구조화 요약
  const summary = await summarizeWithSonnet(rawTranscription);

  // 구조화 요약을 읽기 좋은 텍스트로 변환
  const summaryText = formatSummaryText(summary);

  return {
    transcription: summary.correctedTranscription,
    title: summary.title,
    summary: summaryText,
    agenda: summary.agenda,
    discussions: summary.discussions,
    actionItems: summary.actionItems,
    nextSteps: summary.nextSteps,
    modelUsed: env.ANTHROPIC_API_KEY ? 'gemini-stt+sonnet-summary' : 'gemini-stt+gemini-summary',
  };
}

/** 구조화 요약을 읽기 좋은 마크다운 텍스트로 변환 */
function formatSummaryText(
  s: MeetingSummaryResult,
): string {
  const parts: string[] = [];

  if (s.agenda.length > 0) {
    parts.push(`📋 안건\n${s.agenda.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);
  }

  if (s.discussions.length > 0) {
    parts.push(
      `📝 논의 내용\n${s.discussions.map(d => `▸ ${d.topic}\n  ${d.content}`).join('\n\n')}`,
    );
  }

  if (s.actionItems.length > 0) {
    parts.push(`✅ 액션 아이템\n${s.actionItems.map(a => `• ${a}`).join('\n')}`);
  }

  if (s.nextSteps.length > 0) {
    parts.push(`📌 다음 할 일\n${s.nextSteps.map(n => `• ${n}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

// ── 라우트 등록 ──────────────────────────────────────
export async function meetingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/meetings — 음성으로 회의 생성 ────────
  app.post('/api/meetings', async (request, reply) => {
    const userId = request.userId!;

    let user = await prisma.user.findFirst({ where: { clerkId: userId } });
    if (!user) {
      user = await prisma.user.create({
        data: { clerkId: userId, email: `${userId}@dev.labflow.app` },
      });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: '오디오 파일이 필요합니다' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as unknown as Readable) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return reply.code(400).send({ error: '빈 오디오 파일입니다' });
    }

    if (audioBuffer.length > 10 * 1024 * 1024) {
      return reply.code(413).send({ error: '오디오 파일이 너무 큽니다 (최대 10MB)' });
    }

    const mimeType = data.mimetype || 'audio/webm';

    let duration: number | null = null;
    const durationField = (data.fields as any)?.duration;
    if (durationField?.value) {
      duration = parseInt(durationField.value, 10) || null;
    }

    try {
      const result = await processMeetingAudio(audioBuffer, mimeType);

      const meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: result.title,
          transcription: result.transcription,
          summary: result.summary,
          agenda: result.agenda,
          discussions: JSON.stringify(result.discussions),
          actionItems: result.actionItems,
          nextSteps: result.nextSteps,
          duration,
          modelUsed: result.modelUsed,
        },
      });

      // 🔗 비동기 지식 그래프 관계 추출 (응답 지연 없음)
      const graphText = [
        result.title,
        ...result.agenda,
        ...(result.discussions?.map((d: { topic: string; content: string }) => `${d.topic}: ${d.content}`) || []),
        ...result.actionItems,
      ].join('\n');
      buildGraphFromText(userId, graphText, 'meeting').catch(() => {});

      return reply.code(201).send({
        success: true,
        data: formatMeeting(meeting),
      });
    } catch (error: any) {
      console.error('🎙️ 회의 처리 실패:', error);
      return reply.code(500).send({
        error: error.message || '회의 음성 처리 중 오류가 발생했습니다',
        details: error.message,
      });
    }
  });

  // ── GET /api/meetings — 목록 조회 ──────────────────
  app.get('/api/meetings', async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { clerkId: userId } });
    if (!user) {
      return reply.send({ success: true, data: [], meta: { total: 0, page: 1, limit: query.limit } });
    }

    const [meetings, total] = await Promise.all([
      prisma.meeting.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.meeting.count({ where: { userId: user.id } }),
    ]);

    return reply.send({
      success: true,
      data: meetings.map(formatMeeting),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  // ── GET /api/meetings/:id — 단일 조회 ──────────────
  app.get('/api/meetings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { clerkId: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const meeting = await prisma.meeting.findFirst({
      where: { id, userId: user.id },
    });

    if (!meeting) {
      return reply.code(404).send({ error: '회의를 찾을 수 없습니다' });
    }

    return reply.send({ success: true, data: formatMeeting(meeting) });
  });

  // ── PATCH /api/meetings/:id — 수정 ────────────────
  app.patch('/api/meetings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateMeetingSchema.parse(request.body);
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { clerkId: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const existing = await prisma.meeting.findFirst({ where: { id, userId: user.id } });
    if (!existing) {
      return reply.code(404).send({ error: '회의를 찾을 수 없습니다' });
    }

    const updateData: any = {};
    if (body.title !== undefined) updateData.title = body.title;
    if (body.actionItems !== undefined) updateData.actionItems = body.actionItems;
    if (body.nextSteps !== undefined) updateData.nextSteps = body.nextSteps;

    const meeting = await prisma.meeting.update({
      where: { id },
      data: updateData,
    });

    return reply.send({ success: true, data: formatMeeting(meeting) });
  });

  // ── DELETE /api/meetings/:id — 삭제 ────────────────
  app.delete('/api/meetings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { clerkId: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const existing = await prisma.meeting.findFirst({ where: { id, userId: user.id } });
    if (!existing) {
      return reply.code(404).send({ error: '회의를 찾을 수 없습니다' });
    }

    await prisma.meeting.delete({ where: { id } });
    return reply.send({ success: true });
  });

  // ── POST /api/meetings/transcribe — 전사만 (저장 없이) ─
  app.post('/api/meetings/transcribe', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: '오디오 파일이 필요합니다' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as unknown as Readable) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const audioBuffer = Buffer.concat(chunks);
    const mimeType = data.mimetype || 'audio/webm';

    try {
      const result = await processMeetingAudio(audioBuffer, mimeType);
      return reply.send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      console.error('🎙️ 회의 전사 실패:', error);
      return reply.code(500).send({ error: '회의 전사 중 오류가 발생했습니다' });
    }
  });
}

// ── 응답 포매터 ──────────────────────────────────────
function formatMeeting(meeting: any) {
  // discussions는 JSON 문자열로 저장됨 → 파싱
  let discussions: Array<{ topic: string; content: string }> = [];
  try {
    if (meeting.discussions) {
      discussions = typeof meeting.discussions === 'string'
        ? JSON.parse(meeting.discussions)
        : meeting.discussions;
    }
  } catch {
    discussions = [];
  }

  return {
    id: meeting.id,
    title: meeting.title,
    transcription: meeting.transcription,
    summary: meeting.summary,
    agenda: meeting.agenda || [],
    discussions,
    actionItems: meeting.actionItems || [],
    nextSteps: meeting.nextSteps || [],
    duration: meeting.duration,
    modelUsed: meeting.modelUsed,
    createdAt: meeting.createdAt.toISOString(),
    updatedAt: meeting.updatedAt.toISOString(),
  };
}
