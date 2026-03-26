/**
 * AI 자동분류 서비스
 *
 * Make.com 워크플로우 패턴 재현:
 * [입력] → [Gemini AI 분류] → [JSON 파싱] → [카테고리별 라우팅]
 *
 * 현재: 로컬 키워드 매칭 + 구조화된 프롬프트 (오프라인/무료 모드)
 * 추후: Gemini Flash API → Claude Haiku API (실시간 분류)
 */

import { CaptureCategory } from '../types';

// ── AI 분류 결과 타입 ──────────────────────────────
export interface ClassificationResult {
  category: CaptureCategory;
  confidence: number;       // 0~1 신뢰도
  summary: string;          // AI가 정리한 한줄 요약
  tags: string[];           // 자동 추출 태그
  actionDate?: string;      // 할일인 경우 기한 감지
  priority?: 'high' | 'medium' | 'low';
  modelUsed: 'local' | 'gemini-flash' | 'claude-haiku' | 'gpt-4o-mini';
}

// ── Gemini API 프롬프트 (Make.com 시나리오에서 사용하던 패턴) ──
export const CLASSIFICATION_PROMPT = `당신은 연구자의 빠른 메모를 자동 분류하는 AI입니다.

입력된 텍스트를 분석하여 다음 3가지 카테고리 중 하나로 분류하세요:

1. **task** (할일): 기한이 있거나 실행해야 하는 액션 아이템
   - 예: "내일까지 논문 리뷰 보내기", "실험 데이터 정리해야 함", "3시 미팅 준비"

2. **idea** (아이디어): 나중에 발전시킬 생각, 가설, 영감
   - 예: "하이드로겔 센서를 웨어러블에 적용하면 어떨까", "새로운 실험 방법 생각남"

3. **memo** (메모): 기억해야 할 정보, 참고사항, 기록
   - 예: "김교수님 전화번호 010-xxxx", "세미나실 예약 코드 A301", "PCB 발주 업체 연락처"

반드시 아래 JSON 형식으로만 응답하세요:
{
  "category": "task" | "idea" | "memo",
  "confidence": 0.0~1.0,
  "summary": "한줄 요약 (30자 이내)",
  "tags": ["관련", "태그", "최대3개"],
  "actionDate": "YYYY-MM-DD 또는 null",
  "priority": "high" | "medium" | "low"
}`;

// ── 태그 사전 (연구실 도메인 특화) ──────────────────
const TAG_DICTIONARY: Record<string, string[]> = {
  '논문':    ['논문', 'paper', '리뷰', 'review', '저널', 'journal', '출판', 'publish', 'manuscript', '원고'],
  '실험':    ['실험', 'experiment', '측정', 'measure', '샘플', 'sample', '프로토콜', 'protocol'],
  '데이터':  ['데이터', 'data', '분석', 'analysis', '통계', '그래프', 'plot', 'figure'],
  '센서':    ['센서', 'sensor', '감지', 'detect', '바이오센서', 'biosensor'],
  '바이오':  ['바이오', 'bio', '하이드로겔', 'hydrogel', '세포', 'cell', '생체'],
  '하드웨어': ['pcb', '회로', 'circuit', '기판', '납땜', 'solder', '부품'],
  '미팅':    ['미팅', '회의', '세미나', 'meeting', '발표', 'presentation'],
  '연구실':  ['학생', '연구실', 'lab', '랩', '인턴', '석사', '박사', '지도'],
  '개발':    ['코드', '개발', 'code', 'dev', '프로그래밍', 'api', '서버', '앱'],
  '과제':    ['예산', '과제', '지원사업', '연구비', 'grant', 'funding', 'proposal', '제안서'],
  '수업':    ['수업', '강의', '학생', '과제', '시험', '성적', '채점'],
  '행정':    ['서류', '증명서', '출장', '정산', '보고서', '제출'],
};

// ── 할일 키워드 (긴급도 가중치 포함) ──────────────────
const TASK_PATTERNS = {
  high: ['오늘', '지금', '당장', '급히', 'urgent', 'asap', '즉시'],
  medium: ['내일', '이번주', '까지', '마감', 'deadline', '제출', '보내', '해야', '해줘', '하자', '준비', '확인', '검토', '수정', '완료', '예약'],
  low: ['나중에', '언제', '시간날때', '해놓', '잊지마', '잊지 마', 'todo', '해볼'],
};

// ── 아이디어 키워드 ──────────────────────────────────
const IDEA_PATTERNS = [
  '아이디어', '어떨까', '하면 좋겠', '생각', '떠올',
  '시도해볼', '가능할까', '만들면', '개발하면', '접근',
  'idea', '가설', '제안', '전략', '새로운',
  '혹시', '만약', '해볼까', '영감', '인사이트',
  '~으면', '어떻게 하면', '방법이 없을까',
];

// ── 날짜 감지 ─────────────────────────────────────
function detectActionDate(text: string): string | undefined {
  const today = new Date();
  const lower = text.toLowerCase();

  if (lower.includes('오늘')) {
    return today.toISOString().split('T')[0];
  }
  if (lower.includes('내일')) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
  if (lower.includes('모레') || lower.includes('내일모레')) {
    const dayAfter = new Date(today);
    dayAfter.setDate(dayAfter.getDate() + 2);
    return dayAfter.toISOString().split('T')[0];
  }
  if (lower.includes('이번주')) {
    const friday = new Date(today);
    friday.setDate(friday.getDate() + (5 - friday.getDay()));
    return friday.toISOString().split('T')[0];
  }
  if (lower.includes('다음주')) {
    const nextMonday = new Date(today);
    nextMonday.setDate(nextMonday.getDate() + (8 - nextMonday.getDay()));
    return nextMonday.toISOString().split('T')[0];
  }

  // YYYY-MM-DD 또는 M/D 패턴 감지
  const dateMatch = text.match(/(\d{4}[-/]\d{1,2}[-/]\d{1,2})/);
  if (dateMatch) return dateMatch[1].replace(/\//g, '-');

  const shortDate = text.match(/(\d{1,2})월\s*(\d{1,2})일/);
  if (shortDate) {
    return `${today.getFullYear()}-${shortDate[1].padStart(2, '0')}-${shortDate[2].padStart(2, '0')}`;
  }

  return undefined;
}

// ── 로컬 분류 엔진 (오프라인/무료 모드) ────────────────
export function classifyLocal(text: string): ClassificationResult {
  const lower = text.toLowerCase();

  // 1. 카테고리 분류 (점수 기반)
  let taskScore = 0;
  let ideaScore = 0;
  let priority: 'high' | 'medium' | 'low' = 'medium';

  // 할일 점수 계산 (긴급도별 가중치)
  for (const p of TASK_PATTERNS.high) {
    if (lower.includes(p)) { taskScore += 3; priority = 'high'; }
  }
  for (const p of TASK_PATTERNS.medium) {
    if (lower.includes(p)) taskScore += 2;
  }
  for (const p of TASK_PATTERNS.low) {
    if (lower.includes(p)) { taskScore += 1; if (priority !== 'high') priority = 'low'; }
  }

  // 아이디어 점수 계산
  for (const p of IDEA_PATTERNS) {
    if (lower.includes(p)) ideaScore += 2;
  }

  // 물음표(?) → 아이디어 가능성 높임
  if (text.includes('?') || text.includes('？')) ideaScore += 1;

  // 카테고리 결정
  let category: CaptureCategory;
  let confidence: number;

  if (taskScore > ideaScore && taskScore >= 2) {
    category = 'task';
    confidence = Math.min(0.95, 0.6 + taskScore * 0.05);
  } else if (ideaScore > taskScore && ideaScore >= 2) {
    category = 'idea';
    confidence = Math.min(0.95, 0.6 + ideaScore * 0.05);
  } else if (taskScore > 0 && ideaScore > 0) {
    // 둘 다 점수가 있으면 높은 쪽, 동점이면 task 우선
    category = taskScore >= ideaScore ? 'task' : 'idea';
    confidence = 0.55;
  } else {
    category = 'memo';
    confidence = taskScore === 0 && ideaScore === 0 ? 0.8 : 0.5;
    priority = 'low';
  }

  // 2. 태그 자동 추출
  const tags: string[] = [];
  for (const [tag, keywords] of Object.entries(TAG_DICTIONARY)) {
    if (keywords.some(kw => lower.includes(kw))) {
      tags.push(tag);
    }
    if (tags.length >= 3) break; // 최대 3개
  }

  // 3. 요약 생성
  const summary = generateSummary(text, category);

  // 4. 날짜 감지 (할일인 경우)
  const actionDate = category === 'task' ? detectActionDate(text) : undefined;

  return {
    category,
    confidence,
    summary,
    tags,
    actionDate,
    priority,
    modelUsed: 'local',
  };
}

// ── 요약 생성 ──────────────────────────────────────
function generateSummary(text: string, category: CaptureCategory): string {
  // 불필요한 조사/어미 제거하고 핵심만 추출
  let summary = text.trim();

  // 너무 길면 자름
  if (summary.length > 50) {
    // 첫 문장이나 핵심 부분만 추출
    const firstSentence = summary.split(/[.!?\n]/)[0];
    if (firstSentence && firstSentence.length <= 50) {
      summary = firstSentence;
    } else {
      summary = summary.substring(0, 47) + '...';
    }
  }

  return summary;
}

// ── API 분류 (Gemini Flash / Claude Haiku) ──────────
// 추후 백엔드 연동 시 활성화
export async function classifyWithAPI(
  text: string,
  model: 'gemini-flash' | 'claude-haiku' | 'gpt-4o-mini' = 'gemini-flash'
): Promise<ClassificationResult> {
  // TODO: 실제 API 연동
  // const response = await fetch(`${API_BASE}/classify`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  //   body: JSON.stringify({ text, model, prompt: CLASSIFICATION_PROMPT }),
  // });
  // const data = await response.json();
  // return { ...data, modelUsed: model };

  // 현재는 로컬 분류 fallback
  return classifyLocal(text);
}

// ── 메인 분류 함수 (전략 패턴) ─────────────────────
export async function classify(
  text: string,
  options: {
    useAPI?: boolean;
    preferredModel?: 'gemini-flash' | 'claude-haiku' | 'gpt-4o-mini';
  } = {}
): Promise<ClassificationResult> {
  const { useAPI = false, preferredModel = 'gemini-flash' } = options;

  if (useAPI) {
    try {
      return await classifyWithAPI(text, preferredModel);
    } catch (error) {
      console.warn('API 분류 실패, 로컬 fallback:', error);
      return classifyLocal(text);
    }
  }

  return classifyLocal(text);
}
