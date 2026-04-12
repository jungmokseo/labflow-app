/**
 * 캡처 분류 서비스 (향상된 버전)
 *
 * 기존 gemini-classifier.ts를 확장:
 * - 한국어 마감일 자연어 파싱 (금요일까지, 다음 주 월요일, 3월 말 등)
 * - 긴급도 자동 계산 (마감일 기반)
 * - 사람/프로젝트/키워드 태그 자동 추출
 * - ~$0.001/건 (Gemini Flash)
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── 타입 ──────────────────────────────────────────
export interface CaptureClassification {
  type: 'idea' | 'task' | 'memo';
  tags: string[];
  dueDate: string | null;       // ISO 8601 format
  urgency: 'high' | 'medium' | 'low' | null;  // task만
  summary: string;
  confidence: number;
}

// ── 분류 프롬프트 ────────────────────────────────────
function buildClassificationPrompt(userInput: string): string {
  const today = new Date().toISOString().split('T')[0];
  const dayOfWeek = ['일', '월', '화', '수', '목', '금', '토'][new Date().getDay()];

  return `사용자 입력을 분석하여 JSON으로 분류하세요.

입력: "${userInput}"

오늘 날짜: ${today} (${dayOfWeek}요일)

분류 규칙:
- type "task" (행동이 필요한 것): 할 일, 해야 할 것, ~까지, 마감, 제출, 보내기, 해줘, 확인, 검토, 수정, 준비, 예약, 정리, 작성, 연락, 보고, 처리, 완료, 설정, 등록, 업로드, 다운로드, 만들기, ~하기 (동사+하기 패턴은 거의 항상 task)
- type "idea" (생각/제안): 아이디어, ~하면 어떨까, ~해보자, 생각, 가설, 제안, 영감, 만약, 시도, ~해볼까, 실험해보
- type "memo" (정보 기록만): 전화번호, 코드, 주소, 참고 정보, 회의 내용 기록, 순수 정보 메모
- **핵심 판단 기준: 동작(action)이 포함되면 task, 순수 정보 기록만이면 memo**
- **"~하기", "~할 것", "~해야", "~확인", "~정리", "~준비", "~시작" 으로 끝나면 무조건 task. memo로 절대 분류하지 마세요.**
- **의심스러우면 memo보다 task를 선택하세요. task를 memo로 분류하는 것이 그 반대보다 훨씬 해롭습니다.**

마감일 감지 (한국어 자연어 → ISO 날짜):
- "금요일까지" → 이번 주 금요일 날짜
- "다음 주 월요일" → 해당 날짜
- "3월 말까지" → 3월 31일
- "내일까지" → 내일 날짜
- "이번 주 내" → 이번 주 금요일
- 없으면 null

태그 자동 추출:
- 사람 이름 (예: 김교수님, 서정목, John)
- 프로젝트명, 과제명
- 핵심 키워드 (기술 용어, 장비명 등)
- 최대 5개

긴급도 (task인 경우만):
- 오늘까지/이미 지남/긴급/급히 → "high"
- 3일 이내/내일/모레/이번주 → "medium"
- 그 외/마감 없음 → "low"
- idea/memo는 null

요약 규칙 (매우 중요):
- 사용자가 언급한 정보(누가, 무엇을, 언제)가 있으면 그대로 포함하세요
- **없는 정보는 절대 지어내지 마세요** — 원문에 없는 이름, 날짜, 맥락을 추가하지 마세요
- 원문을 최대한 그대로 살려서 요약하세요
- 예: "한빛 학생 과제 피드백 하기" → "한빛 학생 과제 피드백 하기" (그대로)
- 예: "보고서 제출해야 해" → "보고서 제출" (누구/언제 정보 없으면 추가 안함)

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만:
{
  "type": "idea" | "task" | "memo",
  "tags": ["태그1", "태그2"],
  "dueDate": "2026-04-01T00:00:00Z" | null,
  "urgency": "high" | "medium" | "low" | null,
  "summary": "구체적 요약 — 누가/무엇을/언제 포함 (80자 이내)",
  "confidence": 0.0~1.0
}`;
}

// ── Gemini 분류 ──────────────────────────────────────
export async function classifyCapture(text: string): Promise<CaptureClassification> {
  try {
    const prompt = buildClassificationPrompt(text);
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
      },
    });

    const response = result.response.text().trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Gemini response');

    const parsed = JSON.parse(jsonMatch[0]);

    // 유효성 검증
    const validTypes = ['idea', 'task', 'memo'];
    const validUrgencies = ['high', 'medium', 'low'];

    const type = validTypes.includes(parsed.type) ? parsed.type : 'memo';

    return {
      type,
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
      dueDate: parsed.dueDate && parsed.dueDate !== 'null' ? parsed.dueDate : null,
      urgency: type === 'task' && validUrgencies.includes(parsed.urgency) ? parsed.urgency : null,
      summary: String(parsed.summary || text).substring(0, 80),
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.7)),
    };
  } catch (error) {
    console.warn('[warn] Gemini 캡처 분류 실패, 로컬 fallback:', error);
    return classifyCaptureLocal(text);
  }
}

// ── 로컬 분류 fallback ───────────────────────────────
const TASK_KEYWORDS = [
  '까지', '마감', '제출', '보내', '해야', '해줘', '준비', '확인',
  '검토', '수정', '완료', '예약', '해놓', '처리', '연락',
  '하기', '정리', '작성', '설정', '등록', '업로드', '시작',
  '회신', '답장', '전달', '공유', '미팅', '점검',
];
const IDEA_KEYWORDS = [
  '아이디어', '어떨까', '해보자', '생각', '가설', '제안', '영감',
  '만약', '시도', '접근', '가능', '새로운', '떠올', '혹시',
];

function classifyCaptureLocal(text: string): CaptureClassification {
  const lower = text.toLowerCase();
  let taskScore = 0;
  let ideaScore = 0;

  for (const kw of TASK_KEYWORDS) {
    if (lower.includes(kw)) taskScore++;
  }
  for (const kw of IDEA_KEYWORDS) {
    if (lower.includes(kw)) ideaScore++;
  }
  if (text.includes('?') || text.includes('？')) ideaScore++;

  // "~하기", "~할 것", "~해야" 등 동사 패턴 → 강하게 task
  if (/하기\s*$/.test(text.trim()) || /할\s*것\s*$/.test(text.trim()) || /해야\s*$/.test(text.trim())) {
    taskScore += 3;
  }
  // "~확인", "~정리", "~준비" 등으로 끝나는 경우도 task
  if (/(?:확인|정리|준비|작성|검토|제출|처리|시작|회신|점검)\s*$/.test(text.trim())) {
    taskScore += 2;
  }

  let type: 'idea' | 'task' | 'memo';
  if (taskScore > ideaScore && taskScore >= 1) {
    type = 'task';
  } else if (ideaScore > taskScore && ideaScore >= 1) {
    type = 'idea';
  } else {
    type = 'memo';
  }

  return {
    type,
    tags: [],
    dueDate: null,
    urgency: type === 'task' ? 'low' : null,
    summary: text.length > 80 ? text.substring(0, 77) + '...' : text,
    confidence: 0.5,
  };
}

// ── CaptureCategory 변환 헬퍼 ─────────────────────────
export function typeToCategory(type: string): 'IDEA' | 'TASK' | 'MEMO' {
  switch (type) {
    case 'idea': return 'IDEA';
    case 'task': return 'TASK';
    default: return 'MEMO';
  }
}

export function urgencyToPriority(urgency: string | null): 'HIGH' | 'MEDIUM' | 'LOW' {
  switch (urgency) {
    case 'high': return 'HIGH';
    case 'medium': return 'MEDIUM';
    default: return 'LOW';
  }
}
