/**
 * Gemini Flash AI 분류 서비스
 *
 * 프론트의 ai-classifier.ts 로직을 서버사이드로 이관
 * - Gemini 2.0 Flash (무료 티어) 사용
 * - 로컬 분류 fallback 포함
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../config/env.js';

// ── 타입 ──────────────────────────────────────────
export interface ClassificationResult {
  category: 'IDEA' | 'TASK' | 'MEMO';
  confidence: number;
  summary: string;
  tags: string[];
  actionDate: string | null;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  modelUsed: string;
}

// ── Gemini 클라이언트 ────────────────────────────────
const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── 분류 프롬프트 ────────────────────────────────────
const SYSTEM_PROMPT = `당신은 연구자의 빠른 메모를 자동 분류하는 AI입니다.

입력된 텍스트를 분석하여 다음 3가지 카테고리 중 하나로 분류하세요:

1. **TASK** (할일): 기한이 있거나 실행해야 하는 액션 아이템
   - 예: "내일까지 논문 리뷰 보내기", "실험 데이터 정리해야 함", "3시 미팅 준비"

2. **IDEA** (아이디어): 나중에 발전시킬 생각, 가설, 영감
   - 예: "하이드로겔 센서를 웨어러블에 적용하면 어떨까", "새로운 실험 방법 생각남"

3. **MEMO** (메모): 기억해야 할 정보, 참고사항, 기록
   - 예: "김교수님 전화번호 010-xxxx", "세미나실 예약 코드 A301"

오늘 날짜: ${new Date().toISOString().split('T')[0]}

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만:
{
  "category": "TASK" | "IDEA" | "MEMO",
  "confidence": 0.0~1.0,
  "summary": "한줄 요약 (30자 이내)",
  "tags": ["관련", "태그", "최대3개"],
  "actionDate": "YYYY-MM-DD 또는 null",
  "priority": "HIGH" | "MEDIUM" | "LOW"
}`;

// ── Gemini 분류 ──────────────────────────────────────
export async function classifyWithGemini(text: string): Promise<ClassificationResult> {
  const result = await model.generateContent({
    contents: [
      { role: 'user', parts: [{ text: `${SYSTEM_PROMPT}\n\n분류할 텍스트:\n"${text}"` }] },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 512,
    },
  });

  const response = result.response.text().trim();
  // Extract JSON from response (may contain thinking text before/after)
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Gemini response');
  const parsed = JSON.parse(jsonMatch[0]);

  // 유효성 검증
  const validCategories = ['IDEA', 'TASK', 'MEMO'];
  const validPriorities = ['HIGH', 'MEDIUM', 'LOW'];

  return {
    category: validCategories.includes(parsed.category) ? parsed.category : 'MEMO',
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.7)),
    summary: String(parsed.summary || text).substring(0, 50),
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3) : [],
    actionDate: parsed.actionDate && parsed.actionDate !== 'null' ? parsed.actionDate : null,
    priority: validPriorities.includes(parsed.priority) ? parsed.priority : 'MEDIUM',
    modelUsed: 'gemini-flash',
  };
}

// ── 로컬 분류 fallback ───────────────────────────────
const TASK_PATTERNS = {
  high: ['오늘', '지금', '당장', '급히', 'urgent', 'asap', '즉시'],
  medium: ['내일', '이번주', '까지', '마감', 'deadline', '제출', '보내', '해야', '해줘', '준비', '확인', '검토', '수정', '완료', '예약'],
  low: ['나중에', '언제', '시간날때', '해놓', '잊지마', 'todo', '해볼'],
};

const IDEA_PATTERNS = [
  '아이디어', '어떨까', '하면 좋겠', '생각', '떠올',
  '시도해볼', '가능할까', '만들면', '접근', 'idea',
  '가설', '제안', '새로운', '혹시', '만약', '해볼까', '영감',
];

export function classifyLocal(text: string): ClassificationResult {
  const lower = text.toLowerCase();
  let taskScore = 0;
  let ideaScore = 0;
  let priority: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';

  for (const p of TASK_PATTERNS.high) {
    if (lower.includes(p)) { taskScore += 3; priority = 'HIGH'; }
  }
  for (const p of TASK_PATTERNS.medium) {
    if (lower.includes(p)) taskScore += 2;
  }
  for (const p of TASK_PATTERNS.low) {
    if (lower.includes(p)) { taskScore += 1; if (priority !== 'HIGH') priority = 'LOW'; }
  }
  for (const p of IDEA_PATTERNS) {
    if (lower.includes(p)) ideaScore += 2;
  }
  if (text.includes('?') || text.includes('？')) ideaScore += 1;

  let category: 'IDEA' | 'TASK' | 'MEMO';
  let confidence: number;

  if (taskScore > ideaScore && taskScore >= 2) {
    category = 'TASK';
    confidence = Math.min(0.95, 0.6 + taskScore * 0.05);
  } else if (ideaScore > taskScore && ideaScore >= 2) {
    category = 'IDEA';
    confidence = Math.min(0.95, 0.6 + ideaScore * 0.05);
  } else {
    category = 'MEMO';
    confidence = 0.7;
    priority = 'LOW';
  }

  const summary = text.length > 50 ? text.substring(0, 47) + '...' : text;

  return { category, confidence, summary, tags: [], actionDate: null, priority, modelUsed: 'local' };
}

// ── 메인 분류 (Gemini → 로컬 fallback) ───────────────
export async function classify(text: string, useAI: boolean = true): Promise<ClassificationResult> {
  if (useAI) {
    try {
      return await classifyWithGemini(text);
    } catch (error) {
      console.warn('⚠️ Gemini 분류 실패, 로컬 fallback:', error);
      return classifyLocal(text);
    }
  }
  return classifyLocal(text);
}
