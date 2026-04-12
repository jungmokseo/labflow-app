/**
 * Shadow Session Management — 도구별 기억 세션 관리
 */

import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { maybeGenerateSummary } from '../services/session-manager.js';

export type ShadowType = 'email' | 'calendar' | 'knowledge';

/**
 * 도구명 → Shadow Type 매핑
 * tool-use 아키텍처에서 도구명이 곧 intent이므로 직접 매핑
 */
export function shadowTypeFromTool(toolName: string): ShadowType | null {
  if (['get_email_briefing', 'read_email', 'draft_email_reply'].includes(toolName)) return 'email';
  if (['get_calendar', 'create_calendar_event'].includes(toolName)) return 'calendar';
  if (['search_lab_data', 'search_knowledge'].includes(toolName)) return 'knowledge';
  return null;
}

/** @deprecated tool-use 아키텍처로 전환 후 사용하지 않음. shadowTypeFromTool 사용 권장. */
export function determineShadowType(toolName: string, _message?: string): ShadowType | null {
  return shadowTypeFromTool(toolName);
}

/**
 * Shadow Channel 가져오기 or 생성 (유저당 shadowType 1개)
 */
export async function getOrCreateShadow(userId: string, shadowType: ShadowType): Promise<string> {
  const SHADOW_NAMES: Record<ShadowType, string> = {
    email: '이메일 기억',
    calendar: '캘린더 기억',
    knowledge: '지식 기억',
  };
  let channel = await prisma.channel.findFirst({
    where: { userId, shadow: true, shadowType, archived: false },
  });
  if (!channel) {
    channel = await prisma.channel.create({
      data: { userId, type: 'BRAIN', shadow: true, shadowType, name: SHADOW_NAMES[shadowType] },
    });
  }
  return channel.id;
}

/**
 * Shadow에 메시지 저장 + 요약 트리거 (임계값 15)
 */
export async function saveShadowMessage(shadowChannelId: string, userMsg: string, detailResponse: string): Promise<void> {
  const channel = await prisma.channel.findUnique({ where: { id: shadowChannelId }, select: { userId: true } });
  const userId = channel?.userId || '';
  await (prisma.message.createMany as any)({
    data: [
      { channelId: shadowChannelId, userId, role: 'user', content: userMsg },
      { channelId: shadowChannelId, userId, role: 'assistant', content: detailResponse },
    ],
  });
  const msgCount = await prisma.message.count({ where: { channelId: shadowChannelId } });
  await prisma.channel.update({
    where: { id: shadowChannelId },
    data: { messageCount: msgCount, lastMessageAt: new Date() },
  });
  if (msgCount >= 15) {
    maybeGenerateSummary(shadowChannelId, 10).catch((err: any) => console.error('[background] maybeGenerateSummary:', err.message || err));
  }
}

/**
 * Shadow 저장용 압축: 전체 응답에서 핵심만 추출
 */
export async function compressForShadow(fullResponse: string, type: ShadowType): Promise<string> {
  if (type !== 'email') return fullResponse;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: fullResponse }] }],
      systemInstruction: { role: 'user', parts: [{ text: `다음 이메일 브리핑에서 긴급 또는 대응이 필요한 메일만 추출하세요.
광고, 뉴스레터, 단순 알림은 제외합니다.
각 메일을 한 줄로 압축: "발신자 — 제목 — 핵심 내용/필요 액션"
최대 10건. 해당 없으면 "주요 메일 없음"으로 응답.` }] },
      generationConfig: { temperature: 0, maxOutputTokens: 1024 },
    });

    return result.response.text().trim();
  } catch {
    return fullResponse.slice(0, 1000);
  }
}
