/**
 * 주간 논문 모니터링 cron — 매주 월요일 KST 09:00 실행.
 *
 * 14개 저널 RSS에서 논문을 수집하고, 5대 연구 테마 키워드로 필터링한 뒤,
 * Notion 요약 페이지(상단 누적) + Notion DB(★★ 이상 개별 행) + Slack #연구동향에 게시한다.
 *
 * 환경:
 *   NOTION_API_KEY        (필수)
 *   ANTHROPIC_API_KEY     (선택 — Sonnet 한글 요약. 미설정 시 Gemini fallback)
 *   GEMINI_API_KEY        (필수, Sonnet fallback)
 *   SLACK_BOT_TOKEN       (선택 — 미설정 시 Slack 게시 단계만 skip)
 *
 * 마이그레이션 출처: ~/.claude/skills/paper-monitoring/SKILL.md
 *   (Cowork에서 매주 실행하던 14단계 워크플로우를 server-side cron으로 이전.
 *    Python feedparser 대신 Node fetch + 정규식 기반 RSS 파싱.)
 *
 * SKILL Step 매핑:
 *   Step 0  → fetchLastUpdateAndExistingTitles()
 *   Step 1  → fetchAllJournalRss() + filterAndScore()
 *   Step 2  → enrichWithCrossRef() + summarizeWithAi()
 *   Step 3  → insertNotionSummaryPage()
 *   Step 4  → insertNotionDbRows()
 *   Step 6  → postSlackSummary()
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Client as NotionClient } from '@notionhq/client';
import { env } from '../config/env.js';
import { postSlackMessage } from './cron-shared/slack-api.js';

// ── 상수 (SKILL.md Step 0·3·4·6) ──────────────────────────
const NOTION_SUMMARY_PAGE_ID = '312f9f176cf481b9a4caf3c23c20b7c0';
const NOTION_PAPERS_DB_ID = '9d138950-c9f7-430b-a2f8-a6f45c091af0';
const SLACK_CHANNEL_RESEARCH_TRENDS = 'C0B0R3M4X8T'; // #연구동향
const NOTION_PUBLIC_URL = 'https://conscious-grade-b90.notion.site/312f9f176cf481b9a4caf3c23c20b7c0';

// 14개 저널 RSS (SKILL Step 1)
const JOURNALS: Record<string, string> = {
  'Nature': 'https://www.nature.com/nature.rss',
  'Science': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science',
  'Nat. Mater.': 'https://www.nature.com/nmat.rss',
  'Nat. Nanotechnol.': 'https://www.nature.com/nnano.rss',
  'Nat. Biomed. Eng.': 'https://www.nature.com/natbiomedeng.rss',
  'Nat. Electron.': 'https://www.nature.com/natelectron.rss',
  'Sci. Adv.': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=sciadv',
  'Sci. Robot.': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=scirobotics',
  'Adv. Mater.': 'https://onlinelibrary.wiley.com/action/showFeed?jc=15214095&type=etoc&feed=rss',
  'Adv. Funct. Mater.': 'https://onlinelibrary.wiley.com/action/showFeed?jc=16163028&type=etoc&feed=rss',
  'Nat. Sensors': 'https://www.nature.com/natsensors.rss',
  'Nat. Chem. Eng.': 'https://www.nature.com/natchemeng.rss',
  'ACS Nano': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ancac3',
  'ACS Sensors': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ascefj',
};

// 5대 연구 테마 + 키워드 (SKILL "연구 테마 참고" 섹션)
interface Theme {
  keywords: string[];
  icon: string;
}
const THEMES: Record<string, Theme> = {
  'Liquid Metal': {
    icon: '🔬',
    keywords: ['liquid metal', 'gallium', 'egain', 'galinstan', 'lm particle', 'lm nanoparticle', 'liquid-metal', 'pmlmp', 'scope', 'spray printing', 'marangoni', 'self-fusion', 'stretchable electrode', 'deformable conductor', 'liquid metal composite', 'liquid metal alloy', 'room temperature liquid metal', 'liquid metal droplet', 'gallium-based', 'mechano-fluidic', 'sintering-free'],
  },
  '하이드로겔': {
    icon: '🧪',
    keywords: ['hydrogel', 'pva hydrogel', 'paa hydrogel', 'polyvinyl alcohol hydrogel', 'polyacrylic acid hydrogel', 'tannic acid hydrogel', 'double network hydrogel', 'dual network hydrogel', 'self-healing hydrogel', 'hemostasis', 'hemostatic', 'wound healing', 'wound dressing', 'tough hydrogel', 'conductive hydrogel', 'injectable hydrogel', 'hydrogel sensor', 'hydrogel patch', 'adhesive hydrogel', 'ionic hydrogel', 'stretchable hydrogel', 'bioelectronic hydrogel', 'wearable hydrogel', 'anti-freezing hydrogel', 'nonswellable hydrogel', 'nanoconfinement', 'thermosensitive hydrogel', 'hydrogel actuator'],
  },
  'Antifouling Coating': {
    icon: '🛡️',
    keywords: ['antifouling', 'anti-fouling', 'biofouling', 'biofilm', 'lubricant-infused', 'lubricated surface', 'slippery surface', 'slips', 'liquid-infused', 'omniphobic', 'implant coating', 'antibacterial coating', 'antimicrobial surface', 'fouling resistant', 'fouling release', 'non-fouling', 'protein adsorption resistant', 'zwitterionic coating', 'peg coating', 'lois coating', 'l-vip', 'elfs coating', 'tab coating', 'dopamine fluoropolymer', 'antithrombotic coating', 'immune-evasive coating', 'lubricious coating'],
  },
  '이종소재 접착제': {
    icon: '🔗',
    keywords: ['tissue adhesive', 'bioadhesive', 'bio-adhesive', 'dopamine adhesive', 'mussel-inspired adhesive', 'catechol adhesive', 'chain entanglement', 'heterogeneous bonding', 'dissimilar material bonding', 'universal adhesive', 'underwater adhesive', 'wet adhesion', 'tough adhesion', 'interfacial bonding adhesive', 'sa-dopa', 'd-hapt', 'surgical adhesive', 'wound closure adhesive', 'sealant adhesive', 'moisture-derived adhesion', 'dried-hydrogel adhesive'],
  },
  'Neuromorphic Device': {
    icon: '🧠',
    keywords: ['neuromorphic', 'memristor', 'memristive', 'synaptic device', 'synaptic transistor', 'in-memory computing', 'resistive switching', 'artificial synapse', 'spiking neural', 'brain-inspired computing', 'reservoir computing', 'neural interface', 'brain-computer interface', 'neural recording', 'neural electrode'],
  },
};
const MAX_PAPERS = 30;

// ── 타입 정의 ─────────────────────────────────────────────
interface Paper {
  title: string;
  journal: string;
  link: string;
  doi: string | null;
  doiUrl: string;
  publishedDate: string | null;     // YYYY-MM-DD
  rssSummary: string;
  score: number;                    // 0(매칭없음) ~ 3(★★★)
  rating: '★★★ 직접 관련' | '★★ 높은 관련' | '★ 참고' | null;
  themes: string[];
  matchedKeywords: string[];
  abstract: string;                 // CrossRef enrichment 결과
  authors: string[];
  koreanSummary?: string;           // AI 요약 (Step 2)
  relevanceAnalysis?: string;       // AI 연관성 분석
}

export interface PaperMonitoringResult {
  totalRssItems: number;
  filteredCount: number;
  newPapersCount: number;
  notionPageUpdated: boolean;
  slackPosted: boolean;
  errors: string[];
  ranAt: string;
}

// ── Step 1a: 단일 저널 RSS 파싱 (정규식 기반 — feedparser 대체) ──
async function fetchRssFeed(journal: string, url: string): Promise<Array<{ title: string; link: string; description: string; pubDate: string; doi: string | null; guid: string }>> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'BLISS-Lab-PaperMonitor/1.0 (jungmok.seo@gmail.com)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    return parseRssXml(xml);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 매우 가벼운 RSS/Atom 파서 — <item>·<entry> 단위로 추출.
 *  feedparser 만큼 robust하지 않지만 14개 저널 RSS 형식에는 충분. */
function parseRssXml(xml: string): Array<{ title: string; link: string; description: string; pubDate: string; doi: string | null; guid: string }> {
  const items: Array<{ title: string; link: string; description: string; pubDate: string; doi: string | null; guid: string }> = [];
  // RSS: <item>...</item>, Atom: <entry>...</entry>
  const itemPattern = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[2];
    const title = decodeXml(extractTag(block, 'title') || '').trim();
    if (!title) continue;
    // <link href="..."/> (Atom) or <link>URL</link> (RSS)
    let link = extractAttr(block, 'link', 'href') || extractTag(block, 'link') || '';
    link = link.trim();
    const description = decodeXml(extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content') || '');
    const pubDate = (extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || extractTag(block, 'dc:date') || '').trim();
    const guid = (extractTag(block, 'guid') || extractTag(block, 'id') || link).trim();
    // DOI 추출: link 또는 prism:doi 또는 dc:identifier
    const doiText = `${link} ${guid} ${extractTag(block, 'prism:doi') || ''} ${extractTag(block, 'dc:identifier') || ''}`;
    const doiMatch = doiText.match(/(10\.\d{4,}\/[^\s&?#"<>]+)/);
    items.push({ title, link, description, pubDate, doi: doiMatch ? doiMatch[1] : null, guid });
  }
  return items;
}

function extractTag(xml: string, tagName: string): string | null {
  // 단순 첫 매치 — escape 필요한 cases (CDATA 등) 일부 처리
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  // CDATA 제거
  let v = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // 내부 HTML 태그 제거
  v = v.replace(/<[^>]+>/g, '');
  return v;
}

function extractAttr(xml: string, tagName: string, attrName: string): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']+)["']`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** RFC822/ISO8601 → YYYY-MM-DD */
function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ── Step 1b: 키워드 스코어링 (SKILL "관련도 등급") ──────────
function scorePaper(title: string, summary: string): { score: number; rating: Paper['rating']; themes: string[]; keywords: string[] } {
  const text = `${title} ${summary}`.toLowerCase();
  const matchedThemes = new Set<string>();
  const matchedKeywords: string[] = [];
  for (const [themeName, theme] of Object.entries(THEMES)) {
    for (const kw of theme.keywords) {
      if (text.includes(kw.toLowerCase())) {
        matchedThemes.add(themeName);
        if (!matchedKeywords.includes(kw)) matchedKeywords.push(kw);
      }
    }
  }
  const themes = Array.from(matchedThemes);
  if (themes.length >= 2) return { score: 3, rating: '★★★ 직접 관련', themes, keywords: matchedKeywords };
  if (themes.length === 1) return { score: 2, rating: '★★ 높은 관련', themes, keywords: matchedKeywords };
  if (matchedKeywords.length > 0) return { score: 1, rating: '★ 참고', themes, keywords: matchedKeywords };
  return { score: 0, rating: null, themes: [], keywords: [] };
}

// ── Step 1: 14개 저널 RSS 일괄 수집 + 필터링 ──────────────
async function fetchAllJournalRss(sinceDate: Date | null, excludeTitles: Set<string>, errors: string[]): Promise<{ totalRssItems: number; filtered: Paper[] }> {
  let totalRssItems = 0;
  const all: Paper[] = [];

  // 저널별 순차 처리. 한 저널이 실패해도 나머지 진행 (SKILL 트러블슈팅).
  for (const [journal, rssUrl] of Object.entries(JOURNALS)) {
    try {
      const entries = await fetchRssFeed(journal, rssUrl);
      totalRssItems += entries.length;
      for (const e of entries) {
        const titleNorm = e.title.toLowerCase().trim();
        // exclude 매칭 (포함 + 60% 단어 중복)
        let excluded = false;
        for (const ex of excludeTitles) {
          if (ex.includes(titleNorm) || titleNorm.includes(ex)) { excluded = true; break; }
          const exWords = new Set(ex.split(/\s+/));
          const tWords = new Set(titleNorm.split(/\s+/));
          if (exWords.size > 3 && tWords.size > 3) {
            const overlap = [...exWords].filter(w => tWords.has(w)).length / Math.min(exWords.size, tWords.size);
            if (overlap > 0.6) { excluded = true; break; }
          }
        }
        if (excluded) continue;

        const pubDate = normalizeDate(e.pubDate);
        if (sinceDate && pubDate && new Date(pubDate) < sinceDate) continue;

        // Retraction 제외 (SKILL Step 3 "Retraction 논문은 제외")
        if (/retraction|retracted|correction/i.test(e.title)) continue;

        const { score, rating, themes, keywords } = scorePaper(e.title, e.description);
        if (score === 0) continue;

        all.push({
          title: e.title,
          journal,
          link: e.link,
          doi: e.doi,
          doiUrl: e.doi ? `https://doi.org/${e.doi}` : e.link,
          publishedDate: pubDate,
          rssSummary: e.description.slice(0, 500),
          score, rating, themes, matchedKeywords: keywords,
          abstract: '',
          authors: [],
        });
      }
    } catch (err: any) {
      errors.push(`RSS 수집 실패 [${journal}]: ${err?.message || err}`);
      console.warn(`[paper-monitoring] ${journal} RSS 실패:`, err?.message || err);
    }
  }

  // 점수 내림차순 정렬, 상위 N편 (★★★·★★ 모두 보존, ★는 잘림)
  all.sort((a, b) => b.score - a.score);
  let filtered = all;
  if (filtered.length > MAX_PAPERS) {
    const high = filtered.filter(p => p.score >= 2);
    const low = filtered.filter(p => p.score < 2);
    filtered = [...high, ...low.slice(0, Math.max(0, MAX_PAPERS - high.length))];
  }
  return { totalRssItems, filtered };
}

// ── Step 2a: CrossRef 메타데이터 보강 (★★ 이상만) ─────────
async function enrichWithCrossRef(papers: Paper[]): Promise<void> {
  for (const p of papers) {
    if (p.score < 2 || !p.doi) continue;
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`https://api.crossref.org/works/${p.doi}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'BLISS-Lab-PaperMonitor/1.0 (mailto:jungmok.seo@gmail.com)' },
      });
      clearTimeout(tid);
      if (!res.ok) continue;
      const data = await res.json() as any;
      const msg = data?.message || {};
      const abstract = String(msg.abstract || '').replace(/<[^>]+>/g, '').trim();
      if (abstract) p.abstract = abstract;
      const authors = (msg.author || []).slice(0, 5).map((a: any) => {
        const name = `${a.given || ''} ${a.family || ''}`.trim();
        const aff = (a.affiliation && a.affiliation[0]?.name) ? ` (${a.affiliation[0].name})` : '';
        return name + aff;
      }).filter((s: string) => s);
      if (authors.length) p.authors = authors;
      // CrossRef rate limit 대응
      await new Promise(r => setTimeout(r, 500));
    } catch {
      // 보강 실패는 silent — RSS 정보로 진행 (SKILL 트러블슈팅)
    }
  }
}

// ── Step 2b: AI 한글 요약·연관성 분석 (Sonnet → Gemini fallback) ──
async function summarizeWithAi(papers: Paper[], errors: string[]): Promise<void> {
  // ★★ 이상만 AI 요약. ★는 토글에 RSS 요약 첫 문장만 사용.
  const targets = papers.filter(p => p.score >= 2);
  if (!targets.length) return;

  const prompt = `다음은 BLISS Lab(연세대 서정목 교수, 바이오 유연 전자소자 연구실) 5대 테마와 매칭된 논문들이다.
각 논문에 대해 다음을 JSON 배열로 출력하라:
- index (0-based)
- koreanSummary: 한글 2-3문장. 핵심 기여와 방법론 중심.
- relevanceAnalysis: 이 논문이 BLISS Lab 어떤 테마(${Object.keys(THEMES).join(', ')})와 어떻게 연관되는지 1-2문장.

[논문 목록]
${targets.map((p, i) => `[${i}] ${p.title} (${p.journal}, ${p.publishedDate || '날짜미상'})\n매칭테마: ${p.themes.join(', ')}\n초록: ${(p.abstract || p.rssSummary).slice(0, 800)}`).join('\n\n')}

JSON 배열만 출력 (코드블록 OK).`;

  // 1) Sonnet 시도
  if (env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      // Sonnet 4.6 multi-block response 대응 — thinking + text 가능, text 블록만 추출
      const textBlock = res.content.find(b => b.type === 'text');
      const text = textBlock?.type === 'text' ? textBlock.text : '';
      const arr = parseJsonArray(text);
      applyAiSummary(targets, arr);
      return;
    } catch (e: any) {
      errors.push(`Sonnet 요약 실패 → Gemini fallback: ${e?.message || e}`);
    }
  }

  // 2) Gemini fallback
  try {
    const gemini = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = gemini.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const res = await model.generateContent(prompt);
    const text = res.response.text();
    const arr = parseJsonArray(text);
    applyAiSummary(targets, arr);
  } catch (e: any) {
    errors.push(`Gemini 요약도 실패 — RSS 요약으로 대체: ${e?.message || e}`);
    // 최종 fallback: RSS summary 첫 2문장을 koreanSummary로 사용
    for (const p of targets) {
      if (!p.koreanSummary) p.koreanSummary = p.rssSummary.split(/[.!?]\s/).slice(0, 2).join('. ').slice(0, 300) || '(요약 없음)';
      if (!p.relevanceAnalysis) p.relevanceAnalysis = `매칭 테마: ${p.themes.join(', ')}`;
    }
  }
}

function parseJsonArray(text: string): any[] {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = codeBlock ? codeBlock[1] : text;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
}

function applyAiSummary(targets: Paper[], arr: any[]): void {
  for (const item of arr) {
    const idx = Number(item?.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < targets.length) {
      if (typeof item.koreanSummary === 'string') targets[idx].koreanSummary = item.koreanSummary;
      if (typeof item.relevanceAnalysis === 'string') targets[idx].relevanceAnalysis = item.relevanceAnalysis;
    }
  }
}

// ── Step 0: Notion 요약 페이지 → 마지막 주차·기존 제목 ──────
async function fetchLastUpdateAndExistingTitles(notion: NotionClient): Promise<{ sinceDate: Date | null; excludeTitles: Set<string> }> {
  const titles = new Set<string>();
  let latestEnd: Date | null = null;
  try {
    let cursor: string | undefined;
    do {
      const resp = await notion.blocks.children.list({ block_id: NOTION_SUMMARY_PAGE_ID, page_size: 100, start_cursor: cursor });
      for (const b of resp.results as any[]) {
        // 주차 헤더에서 종료일 추출 (예: "📅 2026년 5월 1주차 (4.27 ~ 5.03)")
        if (b.type === 'heading_1') {
          const text = (b.heading_1?.rich_text || []).map((t: any) => t.plain_text || '').join('');
          const m = text.match(/\(\s*\d+\.\d+\s*~\s*(\d+)\.(\d+)\s*\)/);
          const yearMatch = text.match(/(\d{4})년/);
          if (m && yearMatch) {
            const year = Number(yearMatch[1]);
            const month = Number(m[1]);
            const day = Number(m[2]);
            const d = new Date(Date.UTC(year, month - 1, day));
            if (!latestEnd || d > latestEnd) latestEnd = d;
          }
        }
        // 토글 블록 제목에서 논문 제목 추출 (예: "Paper Title (Nature) ★★★")
        if (b.type === 'toggle') {
          const text = (b.toggle?.rich_text || []).map((t: any) => t.plain_text || '').join('');
          // " (저널명)" 직전까지가 논문 제목
          const m = text.match(/^(.*?)\s+\([^)]+\)\s*★/);
          if (m) {
            titles.add(m[1].trim().toLowerCase());
          }
        }
      }
      cursor = resp.has_more ? resp.next_cursor || undefined : undefined;
    } while (cursor);
  } catch (e: any) {
    console.warn('[paper-monitoring] Notion 페이지 조회 실패 (전체 수집으로 진행):', e?.message || e);
  }
  return { sinceDate: latestEnd, excludeTitles: titles };
}

// ── Step 3: Notion 요약 페이지 상단에 새 주차 삽입 ─────────
async function insertNotionSummaryPage(notion: NotionClient, papers: Paper[], totalRss: number, weekHeader: string, narrative: string, errors: string[]): Promise<boolean> {
  try {
    // 새 블록 배열 구성: 헤더 → 통계 → 줄글 → 테마별 토글 → 시사점
    const blocks: any[] = [];
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push(headingBlock(1, `📅 ${weekHeader}`));
    blocks.push(paragraphBlock(`수집 저널: Nature, Science 등 14개 저널`));
    blocks.push(paragraphBlock(`필터링 결과: 총 ${totalRss}편 중 ${papers.length}편 관련 논문 선별 (중복·정정 제외)`));
    blocks.push(paragraphBlock(narrative));

    // 테마별 섹션 (5개)
    for (const [themeName, theme] of Object.entries(THEMES)) {
      blocks.push(headingBlock(2, `${theme.icon} ${themeName}`));
      const themePapers = papers.filter(p => p.themes.includes(themeName) && p.score >= 2);
      if (themePapers.length === 0) {
        blocks.push(paragraphBlock('이번 주 관련 논문 없음'));
        continue;
      }
      for (const p of themePapers) {
        blocks.push(toggleBlock(`${p.title} (${p.journal}) ${p.rating || ''}`.trim(), [
          paragraphBlock(`저널: ${p.journal} | 발행일: ${p.publishedDate || '미상'}`),
          paragraphBlock(`🔗 ${p.doiUrl}`),
          paragraphBlock(p.koreanSummary || '(요약 없음)'),
          paragraphBlock(`키워드 매칭: ${p.matchedKeywords.slice(0, 6).join(', ')}`),
        ]));
      }
    }

    // 기타 ★ 논문
    const otherPapers = papers.filter(p => p.score === 1);
    if (otherPapers.length) {
      blocks.push(headingBlock(2, '📌 기타 주목할 논문'));
      blocks.push(toggleBlock(`기타 관련 논문 ${otherPapers.length}편`, otherPapers.map(p =>
        paragraphBlock(`• ${p.title} (${p.journal}) — ${p.doiUrl}`)
      )));
    }

    // Notion API: 페이지 내용 맨 뒤(append)에 추가됨. SKILL은 "상단 삽입"을 요구하지만
    // @notionhq/client는 after-block 삽입을 지원하지 않는 환경에서 append로 fallback.
    // 새 주차가 페이지 끝에 추가되며, 운영자가 시각적으로 위로 올리거나 정렬 view 사용.
    // (Cowork SKILL의 selection_with_ellipsis 방식은 server-side에서 재현 불가)
    // 한 번에 100 블록씩 청크 업로드.
    for (let i = 0; i < blocks.length; i += 100) {
      await notion.blocks.children.append({
        block_id: NOTION_SUMMARY_PAGE_ID,
        children: blocks.slice(i, i + 100),
      } as any);
    }
    return true;
  } catch (e: any) {
    errors.push(`Notion 페이지 업데이트 실패: ${e?.message || e}`);
    return false;
  }
}

function paragraphBlock(text: string): any {
  return {
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] },
  };
}
function headingBlock(level: 1 | 2 | 3, text: string): any {
  const key = `heading_${level}` as 'heading_1' | 'heading_2' | 'heading_3';
  return { object: 'block', type: key, [key]: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] } };
}
function toggleBlock(summary: string, children: any[]): any {
  return {
    object: 'block', type: 'toggle',
    toggle: {
      rich_text: [{ type: 'text', text: { content: summary.slice(0, 1900) } }],
      children: children.slice(0, 100), // toggle도 child 100개 제한
    },
  };
}

// ── Step 4: Notion DB에 ★★ 이상 개별 행 입력 ───────────────
async function insertNotionDbRows(notion: NotionClient, papers: Paper[], errors: string[]): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  let count = 0;
  for (const p of papers.filter(x => x.score >= 2)) {
    try {
      await notion.pages.create({
        parent: { database_id: NOTION_PAPERS_DB_ID },
        properties: {
          '논문 제목': { title: [{ text: { content: p.title.slice(0, 1900) } }] },
          '저널': { select: { name: p.journal } },
          '연구 테마': { multi_select: p.themes.map(t => ({ name: t })) },
          '관련도': p.rating ? { select: { name: p.rating } } : { select: null },
          '발행일': p.publishedDate ? { date: { start: p.publishedDate } } : { date: null },
          '초록 (원문)': { rich_text: [{ text: { content: (p.abstract || p.rssSummary).slice(0, 1900) } }] },
          '초록 (한글)': { rich_text: [{ text: { content: (p.koreanSummary || '').slice(0, 1900) } }] },
          '연관성 분석': { rich_text: [{ text: { content: (p.relevanceAnalysis || '').slice(0, 1900) } }] },
          '관련 연구자': { rich_text: [{ text: { content: p.authors.join(', ').slice(0, 1900) } }] },
          'DOI': { url: p.doiUrl || null },
          '수집일': { date: { start: today } },
        } as any,
      });
      count++;
      await new Promise(r => setTimeout(r, 200)); // Notion rate limit
    } catch (e: any) {
      errors.push(`DB 입력 실패 [${p.title.slice(0, 60)}]: ${e?.message || e}`);
    }
  }
  return count;
}

// ── 줄글 요약 생성 (Notion + Slack 공통 사용 — SKILL Step 3·6 일관성) ──
function buildNarrative(papers: Paper[]): string {
  const themeCounts: Record<string, number> = {};
  for (const p of papers.filter(x => x.score >= 2)) {
    for (const t of p.themes) themeCounts[t] = (themeCounts[t] || 0) + 1;
  }
  const sortedThemes = Object.entries(themeCounts).sort((a, b) => b[1] - a[1]);
  const themeDist = sortedThemes.map(([t, c]) => `${t} ${c}편`).join(', ') || '관련 논문 적음';
  const top3 = papers.filter(p => p.score === 3).slice(0, 2);
  const top3Lines = top3.map(p => `**${p.title}** (${p.journal})`).join(', ');
  return `이번 주는 ${themeDist} 분포로 수집되었다.${top3Lines ? ` 특히 ${top3Lines} 두 편이 본 연구실 핵심 주제와 직접 결합되는 ★★★ 논문으로 가장 주목할 만하다.` : ''} 테마별 키워드 매칭 결과를 토글에서 확인할 수 있다.`;
}

// ── Step 6: Slack #연구동향 게시 ───────────────────────────
async function postSlackSummary(weekHeader: string, totalRss: number, filteredCount: number, narrative: string, errors: string[]): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN) {
    errors.push('SLACK_BOT_TOKEN 미설정 — Slack 게시 skip');
    return false;
  }
  if (filteredCount === 0) {
    // SKILL 주의사항: "신규 논문이 0편이면 게시하지 않는다"
    return false;
  }
  // Slack mrkdwn은 *bold*. **bold**는 그대로 표시되므로 변환.
  const slackNarrative = narrative.replace(/\*\*(.+?)\*\*/g, '*$1*');
  const text = `📚 이번 주 논문 모니터링 업데이트 (${weekHeader})\n\n*필터링 결과*: 총 ${totalRss}편 중 *${filteredCount}편* 관련 논문 선별 (중복·정정 제외)\n\n${slackNarrative}\n\n전체 보기 (토글·하이라이트 그대로):\n👉 ${NOTION_PUBLIC_URL}`;
  const data = await postSlackMessage(SLACK_CHANNEL_RESEARCH_TRENDS, text);
  if (!data.ok) {
    errors.push(`Slack 게시 실패: ${data.error}`);
    return false;
  }
  return true;
}

// ── 주차 라벨 생성 ────────────────────────────────────────
function buildWeekHeader(now = new Date()): string {
  // KST 기준 — 이전 월요일 ~ 일요일 범위로 표기 (월요일 cron이므로 직전 주 기준)
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay();
  // 직전 일요일 (어제)
  const sunday = new Date(kst);
  sunday.setUTCDate(kst.getUTCDate() - day);
  const monday = new Date(sunday);
  monday.setUTCDate(sunday.getUTCDate() - 6);
  const year = monday.getUTCFullYear();
  const month = monday.getUTCMonth() + 1;
  // N주차 — 같은 달 내 몇 번째 월요일인지
  const weekOfMonth = Math.ceil(monday.getUTCDate() / 7);
  const fmt = (d: Date) => `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, '0')}`;
  return `${year}년 ${month}월 ${weekOfMonth}주차 (${fmt(monday)} ~ ${fmt(sunday)})`;
}

// ── 메인 엔트리포인트 ─────────────────────────────────────
/**
 * 주간 논문 모니터링 메인 함수.
 * cron 또는 manual API endpoint에서 호출.
 */
export async function runPaperMonitoring(): Promise<PaperMonitoringResult> {
  const result: PaperMonitoringResult = {
    totalRssItems: 0,
    filteredCount: 0,
    newPapersCount: 0,
    notionPageUpdated: false,
    slackPosted: false,
    errors: [],
    ranAt: new Date().toISOString(),
  };

  if (!env.NOTION_API_KEY) {
    result.errors.push('NOTION_API_KEY 미설정 — 종료');
    return result;
  }

  const notion = new NotionClient({ auth: env.NOTION_API_KEY });

  // Step 0: 마지막 업데이트 + 기존 논문 제목
  const { sinceDate, excludeTitles } = await fetchLastUpdateAndExistingTitles(notion);
  console.log(`[paper-monitoring] since=${sinceDate?.toISOString().slice(0, 10) || 'all'} excludeTitles=${excludeTitles.size}`);

  // Step 1: RSS 수집 + 키워드 필터링
  const { totalRssItems, filtered } = await fetchAllJournalRss(sinceDate, excludeTitles, result.errors);
  result.totalRssItems = totalRssItems;
  result.filteredCount = filtered.length;
  result.newPapersCount = filtered.length;
  console.log(`[paper-monitoring] RSS 수집 ${totalRssItems}편 → 필터 ${filtered.length}편`);

  // 신규 0편이면 Notion·Slack 모두 skip (SKILL: noise 회피)
  if (filtered.length === 0) {
    console.log('[paper-monitoring] 신규 논문 0편 — 모든 출력 skip');
    return result;
  }

  // Step 2a: CrossRef 메타데이터 보강
  await enrichWithCrossRef(filtered);

  // Step 2b: AI 한글 요약 + 연관성 분석
  await summarizeWithAi(filtered, result.errors);

  // 줄글 요약 (Notion·Slack 공통)
  const weekHeader = buildWeekHeader();
  const narrative = buildNarrative(filtered);

  // Step 3: Notion 요약 페이지 업데이트
  result.notionPageUpdated = await insertNotionSummaryPage(notion, filtered, totalRssItems, weekHeader, narrative, result.errors);

  // Step 4: Notion DB에 ★★ 이상 개별 행 입력
  const dbCount = await insertNotionDbRows(notion, filtered, result.errors);
  console.log(`[paper-monitoring] Notion DB 입력 ${dbCount}편`);

  // Step 6: Slack 게시 (Step 3 성공 시에만 — SKILL 주의사항)
  if (result.notionPageUpdated) {
    result.slackPosted = await postSlackSummary(weekHeader, totalRssItems, filtered.length, narrative, result.errors);
  } else {
    result.errors.push('Notion 페이지 업데이트 실패 — Slack 게시 skip');
  }

  console.log(
    `[paper-monitoring] 완료 — rss=${result.totalRssItems} filtered=${result.filteredCount} ` +
    `notion=${result.notionPageUpdated ? 'OK' : 'FAIL'} slack=${result.slackPosted ? 'OK' : 'skip'} ` +
    `errors=${result.errors.length}`,
  );
  return result;
}
