/**
 * 암묵적 피드백 학습 서비스
 *
 * 사용자의 행동에서 이메일 선호도를 자동 학습:
 * - "이 메일 전문 보여줘" → sender_priority +1
 * - "답장 써줘" → sender_priority를 "high"로 승격
 * - 특정 키워드 반복 조회 → keyword_boost에 자동 추가
 */

import { prisma } from '../config/prisma.js';

// ── 타입 정의 ────────────────────────────────────────
export interface EmailPreferenceRules {
  sender_priority: Record<string, number | 'high'>; // 발신자 → 우선순위 점수 or 'high'
  keyword_boost: string[];      // 중요도 상향 키워드
  keyword_suppress: string[];   // 중요도 하향 키워드
  response_mode: 'full' | 'summary_only'; // 응답 모드
}

const DEFAULT_EMAIL_RULES: EmailPreferenceRules = {
  sender_priority: {},
  keyword_boost: [],
  keyword_suppress: [],
  response_mode: 'summary_only',
};

// ── UserPreference 조회/생성 ─────────────────────────
export async function getOrCreatePreference(
  userId: string,
  featureType: string,
): Promise<{ id: string; rules: any; version: number }> {
  let pref = await prisma.userPreference.findUnique({
    where: { userId_featureType: { userId, featureType } },
  });

  if (!pref) {
    const defaultRules = featureType === 'email' ? DEFAULT_EMAIL_RULES : {};
    pref = await prisma.userPreference.create({
      data: { userId, featureType, rules: defaultRules },
    });
  }

  return { id: pref.id, rules: pref.rules, version: pref.version };
}

// ── 이메일 관련 피드백 기록 ──────────────────────────
/**
 * "전문 보여줘" 액션: sender_priority를 +1 증가
 */
export async function recordEmailView(userId: string, senderAddress: string): Promise<void> {
  const pref = await getOrCreatePreference(userId, 'email');
  const rules = pref.rules as EmailPreferenceRules;

  const normalizedSender = senderAddress.toLowerCase().trim();
  const currentScore = rules.sender_priority[normalizedSender];

  if (currentScore === 'high') {
    // 이미 최고 우선순위 — 변경 없음
    return;
  }

  const newScore = (typeof currentScore === 'number' ? currentScore : 0) + 1;

  // 5회 이상 조회 시 자동으로 'high' 승격
  const updatedPriority = newScore >= 5 ? 'high' : newScore;

  await prisma.userPreference.update({
    where: { userId_featureType: { userId, featureType: 'email' } },
    data: {
      rules: {
        ...rules,
        sender_priority: {
          ...rules.sender_priority,
          [normalizedSender]: updatedPriority,
        },
      },
    },
  });
}

/**
 * "답장 써줘" 액션: sender_priority를 'high'로 즉시 승격
 */
export async function recordEmailReply(userId: string, senderAddress: string): Promise<void> {
  const pref = await getOrCreatePreference(userId, 'email');
  const rules = pref.rules as EmailPreferenceRules;

  const normalizedSender = senderAddress.toLowerCase().trim();

  await prisma.userPreference.update({
    where: { userId_featureType: { userId, featureType: 'email' } },
    data: {
      rules: {
        ...rules,
        sender_priority: {
          ...rules.sender_priority,
          [normalizedSender]: 'high',
        },
      },
    },
  });
}

/**
 * 키워드 부스트 추가 (반복 조회 기반)
 */
export async function boostKeyword(userId: string, keyword: string): Promise<void> {
  const pref = await getOrCreatePreference(userId, 'email');
  const rules = pref.rules as EmailPreferenceRules;

  const normalizedKeyword = keyword.toLowerCase().trim();
  if (rules.keyword_boost.includes(normalizedKeyword)) return;

  await prisma.userPreference.update({
    where: { userId_featureType: { userId, featureType: 'email' } },
    data: {
      rules: {
        ...rules,
        keyword_boost: [...rules.keyword_boost, normalizedKeyword],
      },
    },
  });
}

/**
 * 키워드 억제 추가
 */
export async function suppressKeyword(userId: string, keyword: string): Promise<void> {
  const pref = await getOrCreatePreference(userId, 'email');
  const rules = pref.rules as EmailPreferenceRules;

  const normalizedKeyword = keyword.toLowerCase().trim();
  if (rules.keyword_suppress.includes(normalizedKeyword)) return;

  await prisma.userPreference.update({
    where: { userId_featureType: { userId, featureType: 'email' } },
    data: {
      rules: {
        ...rules,
        keyword_suppress: [...rules.keyword_suppress, normalizedKeyword],
      },
    },
  });
}

/**
 * 학습된 preference를 LLM 프롬프트 주입용 문자열로 변환
 */
export function buildPreferencePromptSection(rules: EmailPreferenceRules): string {
  const sections: string[] = [];

  // 발신자 우선순위
  const highPrioritySenders = Object.entries(rules.sender_priority)
    .filter(([_, v]) => v === 'high' || (typeof v === 'number' && v >= 3))
    .map(([sender]) => sender);

  if (highPrioritySenders.length > 0) {
    sections.push(`- High priority senders: ${highPrioritySenders.join(', ')}`);
  }

  // 키워드 부스트
  if (rules.keyword_boost.length > 0) {
    sections.push(`- Important keywords (boost priority): ${rules.keyword_boost.join(', ')}`);
  }

  // 키워드 억제
  if (rules.keyword_suppress.length > 0) {
    sections.push(`- Suppress keywords (lower priority): ${rules.keyword_suppress.join(', ')}`);
  }

  if (sections.length === 0) return '';

  return `\n## User Learned Preferences (implicit feedback)
${sections.join('\n')}
Apply these preferences when classifying emails.`;
}
