/**
 * Seed Paper Service — DOI/제목으로 논문 조회 → 키워드/용어/저널/공저자 자동 추출
 *
 * Semantic Scholar API (무료, 키 불필요) + Gemini Flash 기반 분석
 */

import { env } from '../config/env.js';

// ── 타입 정의 ──────────────────────────────────────

export interface SeedPaperResult {
  // 논문 메타데이터
  title: string;
  authors: string[];
  abstract: string;
  journal: string;
  year: number;
  doi: string;
  citationCount: number;
  url: string;

  // 자동 추출 결과
  extractedKeywords: string[];        // 연구 분야 키워드
  extractedTerms: Array<{             // 전문용어 사전 후보
    term: string;
    definition: string;
    category: string;
  }>;
  coauthors: Array<{                  // 공저자 네트워크
    name: string;
    affiliation: string;
  }>;
  relatedJournals: string[];          // 관련 저널 (논문 알림 추천용)
  suggestedRssKeywords: string[];     // RSS 크롤링 추천 키워드
}

// ── Semantic Scholar API ────────────────────────────

const S2_BASE = 'https://api.semanticscholar.org/graph/v1';
const S2_FIELDS = 'title,authors,abstract,journal,year,externalIds,citationCount,url,references.title,references.journal';

interface S2Paper {
  paperId: string;
  title: string;
  authors: Array<{ authorId: string; name: string }>;
  abstract: string | null;
  journal?: { name: string } | null;
  year: number | null;
  externalIds?: { DOI?: string } | null;
  citationCount: number;
  url: string;
  references?: Array<{ title: string; journal?: { name: string } | null }>;
}

async function fetchFromS2(endpoint: string): Promise<S2Paper | null> {
  try {
    const res = await fetch(`${S2_BASE}${endpoint}`, {
      headers: {
        'User-Agent': 'LabFlow/1.0 (Research Lab OS)',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.json() as S2Paper;
  } catch {
    return null;
  }
}

/**
 * DOI로 논문 조회
 */
export async function lookupByDoi(doi: string): Promise<S2Paper | null> {
  const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '').trim();
  return fetchFromS2(`/paper/DOI:${encodeURIComponent(cleanDoi)}?fields=${S2_FIELDS}`);
}

/**
 * 제목으로 논문 검색 (첫 번째 결과)
 */
export async function lookupByTitle(title: string): Promise<S2Paper | null> {
  try {
    const res = await fetch(
      `${S2_BASE}/paper/search?query=${encodeURIComponent(title)}&limit=1&fields=${S2_FIELDS}`,
      { headers: { 'User-Agent': 'LabFlow/1.0' }, signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { data?: S2Paper[] };
    return data.data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * DOI 또는 제목 자동 감지하여 조회
 */
export async function lookupPaper(input: string): Promise<S2Paper | null> {
  const trimmed = input.trim();
  // DOI 패턴 감지: 10.xxxx/... 형태
  if (/^(https?:\/\/doi\.org\/)?10\.\d{4,}\//.test(trimmed)) {
    return lookupByDoi(trimmed);
  }
  return lookupByTitle(trimmed);
}

// ── Gemini 기반 분석 ────────────────────────────────

/**
 * 논문 초록/제목에서 키워드, 전문용어, 관련 저널을 추출
 */
async function analyzeWithGemini(paper: S2Paper): Promise<{
  keywords: string[];
  terms: Array<{ term: string; definition: string; category: string }>;
  suggestedRssKeywords: string[];
}> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `Analyze this research paper and extract the following. Respond ONLY in JSON.

Title: ${paper.title}
Abstract: ${paper.abstract || 'N/A'}
Journal: ${paper.journal?.name || 'N/A'}
Year: ${paper.year || 'N/A'}

Extract:
1. "keywords": 8-12 research field keywords (English, lowercase, specific to this research area)
2. "terms": 5-10 specialized technical terms from the abstract with brief definitions and categories. Format: [{"term": "exact term", "definition": "1-line definition", "category": "materials|methods|devices|analysis|biology"}]
3. "suggestedRssKeywords": 5-8 keywords optimized for finding similar papers via RSS feeds (broader than keywords)

JSON only:`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    console.warn('Gemini analysis failed:', err);
  }
  return { keywords: [], terms: [], suggestedRssKeywords: [] };
}

// ── 관련 저널 추출 (참고문헌 기반) ──────────────────

function extractRelatedJournals(paper: S2Paper): string[] {
  if (!paper.references || paper.references.length === 0) return [];

  const journalCounts: Record<string, number> = {};
  for (const ref of paper.references) {
    const j = ref.journal?.name;
    if (j) {
      journalCounts[j] = (journalCounts[j] || 0) + 1;
    }
  }

  return Object.entries(journalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name]) => name);
}

// ── 공저자 추출 ─────────────────────────────────────

function extractCoauthors(paper: S2Paper): Array<{ name: string; affiliation: string }> {
  return paper.authors.map(a => ({
    name: a.name,
    affiliation: '', // S2 기본 필드에는 소속이 없음; 필요시 별도 조회
  }));
}

// ══════════════════════════════════════════════════════
//  MAIN: 시드 논문 분석 파이프라인
// ══════════════════════════════════════════════════════

export async function analyzeSeedPaper(input: string): Promise<SeedPaperResult | null> {
  // 1. 논문 조회
  const paper = await lookupPaper(input);
  if (!paper) return null;

  // 2. Gemini 분석 (키워드, 용어, RSS 키워드)
  const analysis = await analyzeWithGemini(paper);

  // 3. 참고문헌에서 관련 저널 추출
  const relatedJournals = extractRelatedJournals(paper);

  // 4. 논문이 실린 저널도 관련 저널에 추가
  if (paper.journal?.name && !relatedJournals.includes(paper.journal.name)) {
    relatedJournals.unshift(paper.journal.name);
  }

  return {
    title: paper.title,
    authors: paper.authors.map(a => a.name),
    abstract: paper.abstract || '',
    journal: paper.journal?.name || '',
    year: paper.year || 0,
    doi: paper.externalIds?.DOI || '',
    citationCount: paper.citationCount || 0,
    url: paper.url || '',

    extractedKeywords: analysis.keywords,
    extractedTerms: analysis.terms,
    coauthors: extractCoauthors(paper),
    relatedJournals,
    suggestedRssKeywords: analysis.suggestedRssKeywords,
  };
}

/**
 * 여러 시드 논문을 병렬 분석하고 결과를 병합
 */
export async function analyzeSeedPapers(inputs: string[]): Promise<{
  papers: SeedPaperResult[];
  mergedKeywords: string[];
  mergedTerms: Array<{ term: string; definition: string; category: string }>;
  mergedJournals: string[];
  mergedRssKeywords: string[];
}> {
  const results = await Promise.all(inputs.map(i => analyzeSeedPaper(i)));
  const papers = results.filter((r): r is SeedPaperResult => r !== null);

  // 키워드 병합 (중복 제거, 빈도순)
  const kwCount: Record<string, number> = {};
  for (const p of papers) {
    for (const kw of p.extractedKeywords) {
      kwCount[kw.toLowerCase()] = (kwCount[kw.toLowerCase()] || 0) + 1;
    }
  }
  const mergedKeywords = Object.entries(kwCount)
    .sort((a, b) => b[1] - a[1])
    .map(([kw]) => kw);

  // 용어 병합 (중복 제거)
  const termSet = new Set<string>();
  const mergedTerms: Array<{ term: string; definition: string; category: string }> = [];
  for (const p of papers) {
    for (const t of p.extractedTerms) {
      if (!termSet.has(t.term.toLowerCase())) {
        termSet.add(t.term.toLowerCase());
        mergedTerms.push(t);
      }
    }
  }

  // 저널 병합
  const journalSet = new Set<string>();
  const mergedJournals: string[] = [];
  for (const p of papers) {
    for (const j of p.relatedJournals) {
      if (!journalSet.has(j)) {
        journalSet.add(j);
        mergedJournals.push(j);
      }
    }
  }

  // RSS 키워드 병합
  const rssSet = new Set<string>();
  for (const p of papers) {
    for (const k of p.suggestedRssKeywords) rssSet.add(k.toLowerCase());
  }

  return {
    papers,
    mergedKeywords,
    mergedTerms,
    mergedJournals: mergedJournals.slice(0, 15),
    mergedRssKeywords: [...rssSet],
  };
}
