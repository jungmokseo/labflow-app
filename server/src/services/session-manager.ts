/**
 * Session Manager — 세션 요약 생성, 자동 정보 추출, 세션 제목 생성
 */

import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { generateEmbedding } from './embedding-service.js';
import { createHash } from 'crypto';
import { logApiCost } from './cost-logger.js';

/**
 * 일정 메시지 수 이상이면 자동 요약 생성
 */
export async function maybeGenerateSummary(channelId: string, minNewMessages: number = 20): Promise<void> {
  const messageCount = await prisma.message.count({ where: { channelId } });
  if (messageCount < minNewMessages) return;

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

  if (newMessages.length < minNewMessages) return;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const conversationText = newMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    const result = await model.generateContent(
      `다음 대화를 간결하게 요약하세요. 핵심 정보를 중심으로 200단어 이내로:\n\n${conversationText}`
    );

    const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { userId: true } });
    const summaryUsage = result.response.usageMetadata;
    if (summaryUsage && channel?.userId) logApiCost(channel.userId, 'gemini-2.5-flash', summaryUsage.promptTokenCount ?? 0, summaryUsage.candidatesTokenCount ?? 0, 'session_summary').catch(() => {});
    const summaryText = result.response.text();
    const summaryUserId = channel?.userId || '';
    const summary = await prisma.channelSummary.create({
      data: {
        channelId,
        userId: summaryUserId,
        summaryText,
        messageRange: `${newMessages[0].id} ~ ${newMessages[newMessages.length - 1].id}`,
      },
    });

    // Auto-embed channel summary (fire-and-forget)
    generateEmbedding(summaryText)
      .then(embResult => {
        const vectorStr = `[${embResult.embedding.join(',')}]`;
        const hash = createHash('sha256').update(summaryText).digest('hex').slice(0, 16);
        return prisma.$executeRawUnsafe(
          `INSERT INTO memo_embeddings (source_type, source_id, user_id, title, chunk_index, chunk_text, content_hash, embedding, metadata)
           VALUES ('channel_summary', $1, $2, 'Channel Summary', 0, $3, $4, $5::vector, '{}')
           ON CONFLICT (source_id, source_type, chunk_index) DO UPDATE SET embedding = $5::vector, chunk_text = $3, content_hash = $4, updated_at = NOW()`,
          summary.id, summaryUserId, summaryText.slice(0, 2000), hash, vectorStr
        );
      })
      .catch(err => console.warn('[embed] channel summary embedding failed:', err));
  } catch (err) {
    console.warn('Session summary generation failed:', err);
  }
}

/**
 * 대화에서 연구실 관련 새 정보 자동 추출
 */
export async function autoExtractInfo(message: string, response: string, labId: string): Promise<void> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `다음 대화에서 연구실 관련 새 정보가 있는지 확인하세요.
추출: 과제-논문 연결, 새 용어, 새 인원, 새 과제 정보
새 정보 없으면 빈 배열: []

사용자: ${message}
AI: ${response}

JSON 배열: [{"type": "dict"|"memo", "data": {...}}]`;

    const result = await model.generateContent(prompt);
    const autoExtractUsage = result.response.usageMetadata;
    if (autoExtractUsage) logApiCost('system', 'gemini-2.5-flash', autoExtractUsage.promptTokenCount ?? 0, autoExtractUsage.candidatesTokenCount ?? 0, 'auto_extract_info').catch(() => {});
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
          }).catch((err: any) => console.error('[background] domainDict upsert:', err.message || err));
        }
      }
    }
  } catch {
    // 자동 추출 실패 무시
  }
}

/**
 * 대화 내용 기반으로 세션 제목 자동 생성 (10자 내외)
 */
export async function generateSessionTitle(messages: Array<{ role: string; content: string }>, latestMessage: string): Promise<string | null> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const context = messages.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    const result = await model.generateContent(
      `다음 대화의 주제를 한국어 10자 이내로 요약하세요. 제목만 출력:\n\n${context}\nuser: ${latestMessage.slice(0, 100)}`
    );
    const titleUsage = result.response.usageMetadata;
    if (titleUsage) logApiCost('system', 'gemini-2.5-flash', titleUsage.promptTokenCount ?? 0, titleUsage.candidatesTokenCount ?? 0, 'session_title').catch(() => {});
    const title = result.response.text().trim().replace(/["']/g, '').slice(0, 30);
    return title || null;
  } catch {
    return null;
  }
}
