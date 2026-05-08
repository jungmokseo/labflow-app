/**
 * Auto-Tagger — 메모/캡처에 자동으로 태그를 분류
 *
 * 8개 카테고리:
 * #인사변경, #과제, #아이디어, #일정, #연구, #회사, #학생, #기타
 *
 * 규칙 기반 1차 분류 + Gemini fallback
 */

import { env } from '../config/env.js';

export const AVAILABLE_TAGS = [
  '#인사변경',  // 인원 변동, 입퇴사, 전보, 교수 임용
  '#과제',      // 연구과제, 사업, 예산, 정산, 보고서
  '#아이디어',  // 연구 아이디어, 구현 방안, 가설
  '#일정',      // 날짜, 회의, 마감, 출장, 학회
  '#연구',      // 실험, 논문, 데이터, 결과, 장비
  '#회사',      // 회사 업무, 매출, 계약, 거래처
  '#학생',      // 학생 관련, 과제, 졸업, 장학금
  '#기타',      // 위에 해당 없음
] as const;

// ── 규칙 기반 분류 (빠르고 무료) ───────────────────
const TAG_RULES: Array<{ tag: string; patterns: RegExp[] }> = [
  {
    tag: '#인사변경',
    patterns: [
      /입학|퇴학|졸업|입사|퇴사|전보|이동|임용|채용|인턴|복학|휴학|수료|박사후/,
      /새로운\s*(학생|연구원|직원|팀원)/,
      /합류|퇴직|이직/,
    ],
  },
  {
    tag: '#과제',
    patterns: [
      /과제|NRF|IITP|산자부|과기부|연구비|예산|정산|중간보고|최종보고|사업|공모/,
      /RFP|제안서|수주|계약|과제번호|사사\s*문구/,
      /협약|선정|탈락|평가/,
    ],
  },
  {
    tag: '#아이디어',
    patterns: [
      /아이디어|구현|방안|가설|시도|새로운\s*방법|접근법|전략/,
      /만약|어떨까|해보면|시도해|실험해/,
      /가능성|제안|컨셉|콘셉트/,
    ],
  },
  {
    tag: '#일정',
    patterns: [
      /\d{1,2}월|\d{1,2}일|내일|다음\s*주|이번\s*주|오늘|다음\s*달/,
      /회의|미팅|출장|학회|컨퍼런스|세미나|발표|마감|deadline/,
      /예약|약속|일정|캘린더|스케줄/,
    ],
  },
  {
    tag: '#연구',
    patterns: [
      /실험|논문|데이터|결과|분석|측정|합성|제작|테스트|시편/,
      /SEM|TEM|XPS|XRD|AFM|IR|Raman|NMR|UV|DLS/i,
      /하이드로겔|액체금속|코팅|센서|바이오|전극|기판|필름|나노/,
      /투고|리뷰|리비전|revision|submit|accept|reject|impact\s*factor/i,
    ],
  },
  {
    tag: '#회사',
    patterns: [
      /회사|매출|계약|거래처|발주|납품|견적|인보이스|청구|법인|스타트업/,
      /사업자|법인|세금|계산서|영수증|결재|품의/,
    ],
  },
  {
    tag: '#학생',
    patterns: [
      /학생|대학원|석사|박사|학부|연구실|랩|지도|면담|상담/,
      /장학금|등록금|학위|논문\s*심사|졸업\s*요건|수업|강의/,
      /주간\s*보고|주보|진행\s*사항/,
    ],
  },
];

/**
 * 텍스트 분석 후 태그 자동 분류 (1개 이상 반환)
 */
export function autoTagByRules(content: string): string[] {
  const matched: string[] = [];
  for (const rule of TAG_RULES) {
    if (rule.patterns.some(p => p.test(content))) {
      matched.push(rule.tag);
    }
  }
  return matched.length > 0 ? matched : ['#기타'];
}

/**
 * Gemini 기반 분류 (규칙으로 불확실할 때)
 */
export async function autoTagWithAI(content: string): Promise<string[]> {
  // 먼저 규칙 기반 시도
  const ruleTags = autoTagByRules(content);
  if (ruleTags.length > 0 && !ruleTags.includes('#기타')) {
    return ruleTags;
  }

  // 규칙으로 불확실하면 Gemini 사용
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent(
      `다음 메모를 분류하세요. 해당하는 태그를 모두 선택하세요.

태그 목록:
- #인사변경: 인원 변동, 입퇴사, 교수 임용
- #과제: 연구과제, 예산, 보고서, 제안서
- #아이디어: 연구 아이디어, 새로운 방법
- #일정: 날짜, 회의, 마감, 출장
- #연구: 실험, 논문, 데이터, 장비
- #회사: 회사 업무, 매출, 계약
- #학생: 학생 관련, 장학금, 졸업
- #기타: 위에 해당 없음

메모: "${content.slice(0, 500)}"

JSON 배열로만 응답: ["#태그1", "#태그2"]`
    );

    const text = result.response.text().trim();
    const match = text.match(/\[.*\]/s);
    if (match) {
      const tags = JSON.parse(match[0]) as string[];
      return tags.filter(t => AVAILABLE_TAGS.includes(t as any));
    }
  } catch { /* fallback to rule-based */ }

  return ruleTags;
}
