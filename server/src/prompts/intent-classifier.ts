/**
 * Intent Classification — 의도 분류 + 정정 감지
 */

import { env } from '../config/env.js';
import { basePrismaClient } from '../config/prisma.js';

// ── Types ─────────────────────────────────────────────
export type Intent =
  | 'query_project' | 'query_publication' | 'query_member' | 'query_meeting'
  | 'multi_hop'
  | 'query_stale'
  | 'save_memo' | 'search_memory' | 'general_chat' | 'add_dict'
  | 'capture_create' | 'capture_list' | 'capture_complete'
  | 'daily_brief' | 'emerge' | 'weekly_review'
  | 'email_briefing' | 'email_query' | 'email_read' | 'email_reply_draft' | 'email_preference'
  | 'calendar_query' | 'calendar_create'
  | 'fallback_search';

export interface ClassifiedIntent {
  intent: Intent;
  entities: Record<string, string>;
  hops?: Array<{
    step: number;
    source: 'member' | 'project' | 'publication' | 'memo' | 'dict';
    lookup: string;
    extract: string;
  }>;
}

export interface ConversationTurn {
  role: string;
  content: string;
}

export interface IntentCorrection {
  originalMessage: string;
  wrongIntent: string;
  correctIntent: string;
}

// ── 학습된 보정 기록 로드/저장 ─────────────────────────
export async function loadIntentCorrections(userId: string): Promise<IntentCorrection[]> {
  try {
    const pref = await basePrismaClient.userPreference.findUnique({
      where: { userId_featureType: { userId, featureType: 'intent_corrections' } },
    });
    if (pref?.rules) {
      const rules = pref.rules as any;
      return Array.isArray(rules.corrections) ? rules.corrections.slice(-20) : [];
    }
  } catch { /* ignore */ }
  return [];
}

export async function saveIntentCorrection(userId: string, correction: IntentCorrection): Promise<void> {
  try {
    const existing = await loadIntentCorrections(userId);
    const updated = [...existing.filter(c => c.originalMessage !== correction.originalMessage), correction].slice(-30);
    const rulesJson = JSON.parse(JSON.stringify({ corrections: updated }));
    await basePrismaClient.userPreference.upsert({
      where: { userId_featureType: { userId, featureType: 'intent_corrections' } },
      update: { rules: rulesJson },
      create: { userId, featureType: 'intent_corrections', rules: rulesJson },
    });
  } catch (err: any) {
    console.error('[intent] Failed to save correction:', err.message);
  }
}

// ── 정정 감지 ─────────────────────────────────────────
const CORRECTION_PATTERNS = [
  /^(아니|아닌데|그거\s*말고|그게\s*아니라|아니야|아뇨|틀렸어)/,
  /말고\s*(.*해줘|.*해)/,
  /(할일|태스크|캡처|메모|아이디어)로\s*(추가|저장|변경)/,
  /이메일\s*(아니|말고)/,
  /다시\s*(해줘|분류|처리)/,
  /시간.*틀|틀렸|잘못|맞지.*않|아닌데|그게.*아니/,
  /시간대.*맞춰|기준으로.*정리|기준으로.*해/,
];

export function detectCorrection(message: string, recentMessages: ConversationTurn[]): {
  isCorrection: boolean;
  previousUserMessage?: string;
  previousAssistantMessage?: string;
} {
  if (recentMessages.length < 2) return { isCorrection: false };

  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(message)) {
      const lastAssistant = [...recentMessages].reverse().find(m => m.role === 'assistant');
      const lastUser = [...recentMessages].reverse().filter(m => m.role === 'user')[1];
      return {
        isCorrection: true,
        previousUserMessage: lastUser?.content,
        previousAssistantMessage: lastAssistant?.content,
      };
    }
  }
  return { isCorrection: false };
}

// ── 의도 분류 ─────────────────────────────────────────
export async function classifyIntent(
  message: string,
  recentContext?: ConversationTurn[],
  learnedCorrections?: IntentCorrection[],
): Promise<ClassifiedIntent> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    let contextBlock = '';
    if (recentContext && recentContext.length > 0) {
      const recent = recentContext.slice(-6);
      contextBlock = `\n\n**최근 대화 (맥락 참조용):**\n${recent.map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content.substring(0, 100)}`).join('\n')}\n`;
    }

    let correctionBlock = '';
    if (learnedCorrections && learnedCorrections.length > 0) {
      const examples = learnedCorrections.slice(-5).map(c =>
        `- "${c.originalMessage}" → ${c.correctIntent} (${c.wrongIntent}은 잘못됨)`
      ).join('\n');
      correctionBlock = `\n\n**이 사용자의 과거 정정 기록 (반드시 반영):**\n${examples}\n`;
    }

    const prompt = `사용자 메시지의 의도를 분류하세요. JSON으로만 응답하세요.
${contextBlock}${correctionBlock}
의도 목록:
- query_project: 단순 과제 질문 (과제 목록, 특정 과제 정보)
- query_publication: 단순 논문 질문 (논문 수, 저널 등)
- query_member: 단순 구성원 질문 (연락처, 역할 등)
- query_meeting: 미팅 관련 질문
- multi_hop: **복합 질의** — 두 종류 이상의 DB를 조합해야 답할 수 있는 질문. 예:
  - "김태영이 참여 중인 과제" (구성원→과제)
  - "TIPS 과제 학생들 이메일" (과제→구성원→이메일)
  - "Nature Communications 논문 저자 연락처" (논문→저자→구성원→연락처)
  - "hemostatic hydrogel 담당자 연락처" (키워드→과제→PM→구성원)
- save_memo: 메모 저장 요청
- search_memory: 과거 정보 검색
- add_dict: 용어 교정 등록
- query_stale: 오래된 정보, 업데이트 필요한 정보, 신뢰도 낮은 정보 질문 (예: "오래된 정보 보여줘", "업데이트 필요한 거 있어?", "확인이 필요한 정보", "신뢰도 낮은 정보")
- capture_create: 빠른 캡처 생성 (메모/태스크/아이디어 기록 요청). 예: "이거 메모해줘", "할 일 추가", "아이디어 저장", "정리하기", "준비해야 해"
- capture_list: 캡처 목록 조회 요청. 예: "캡처 보여줘", "할 일 목록", "아이디어 뭐 있어?"
- capture_complete: 캡처 완료 처리. 예: "이거 완료", "다 했어", "태스크 끝"
- daily_brief: 오늘 브리핑/우선순위 요청. 예: "오늘 할 일", "today", "오늘 브리핑", "오늘 뭐해야 해?"
- emerge: 숨겨진 연결/패턴 발견 요청. 예: "아이디어 연결 찾아줘", "패턴 찾아", "emerge", "숨겨진 연결", "연구 교차점"
- weekly_review: 주간 리뷰/정리 요청. 예: "이번 주 정리", "주간 리뷰", "이번주 뭐 했지?", "weekly"
- email_briefing: 이메일 브리핑 요청. 예: "이메일 확인해줘", "이메일 브리핑 해줘", "메일 뭐 왔어?", "오늘 이메일"
- email_query: 이메일 관련 후속 질문 (브리핑 이후 추가 질문, 특정 이메일 검색). 예: "그 이메일 자세히", "OO교수 이메일"
- email_read: 이메일 전문/전체 내용/원문을 보고 싶을 때, 특정 이메일을 읽고 싶을 때. 예: "이메일 보여줘", "메일 전체 내용", "원문 보여줘", "무슨 내용이야", "자세히 보여줘", "가장 최근 이메일 전체 내용"
- email_reply_draft: 이메일 답장/회신/응답 초안을 작성해달라고 할 때. 예: "답장 써줘", "회신 초안", "이 메일에 답해줘", "reply 해줘", "답장 초안 써줘"
- email_preference: 이메일 분류 설정 변경 요청. 예: "학술지 리뷰 중요도 올려줘", "광고 메일 제외해줘", "OO 키워드 중요하게 처리해", "이메일 분류 규칙 바꿔줘", "뉴스레터 안 보여줘"
- calendar_query: 캘린더/일정 조회 관련. 예: "오늘 일정", "이번주 스케줄", "다음 미팅 언제"
- calendar_create: 일정/이벤트/미팅/회의를 캘린더에 등록/생성/추가할 때. 예: "일정 등록해줘", "캘린더에 넣어줘", "일정 만들어줘", "미팅 잡아줘", "이 미팅을 일정에 등록해줘"
- general_chat: 일반 대화

**분류 규칙:**
1. "~해야함", "~하기", "~준비", "~정리" 같은 할일/행동 표현은 capture_create 또는 general_chat이지, email_briefing이 아닙니다.
2. email_briefing은 **반드시 이메일/메일/email/Gmail/브리핑을 명시적으로 언급**한 경우에만 선택하세요.
3. 애매하면 general_chat으로 분류하세요.

**잘못 분류되기 쉬운 예시:**
- "미팅 아젠다 정리하기" → capture_create (할일), email_briefing이 아님!
- "오늘 브리핑" → daily_brief (오늘 할일), email_briefing이 아님!
- "이메일 확인해줘" → email_briefing (이메일 명시 언급)
- "리뷰 중요도 올려줘" → email_preference (이메일 설정)

multi_hop인 경우 "hops" 배열을 추가하세요:
- step: 순서 (1, 2, 3)
- source: 조회할 DB (member, project, publication, memo, dict)
- lookup: 검색 키워드
- extract: 추출할 필드

사용자 메시지: "${message}"

응답 예시:
단순: {"intent": "query_member", "entities": {"name": "김태영"}}
복합: {"intent": "multi_hop", "entities": {"query": "TIPS 과제 학생 이메일"}, "hops": [
  {"step": 1, "source": "project", "lookup": "TIPS", "extract": "pm"},
  {"step": 2, "source": "member", "lookup": "(step1 결과의 pm)", "extract": "email"}
]}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const match = text.match(/\{.*\}/s);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    console.warn('Intent classification failed:', err);
  }
  return { intent: 'fallback_search', entities: { query: '' } };
}
