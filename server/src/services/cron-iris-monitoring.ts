/**
 * IRIS(범부처통합연구지원시스템) R&D 과제 모니터링 cron.
 *
 * Notion DB '📝 IRIS 연구과제 공고'에 신규 과제만 상단(prepend)에 누적 추가.
 * 기존 항목은 공고번호(또는 ancmId)로 중복 검사 후 skip.
 *
 * 환경:
 *   NOTION_API_KEY (필수)
 *
 * 마이그레이션 출처: ~/.claude/skills/iris-monitoring/SKILL.md (+ scripts/iris_crawler.py)
 *   - LIST API endpoint, POST body 구조, 기술분야 필터(techFild3/5/7/9/11),
 *     필드 매핑(ancmTl, ancmDe, rcveStrDe, rcveEndDe, blngGovdSeNm, sorgnNm, pbofrTpSeNmLst, dDay)
 *     모두 SKILL의 Python 크롤러를 그대로 TypeScript로 이식.
 *   - HTML 파싱 불필요: IRIS는 JSON API를 노출. plain fetch 만 사용 (cheerio 등 X).
 *
 * 정책:
 *   기술분야 필터 = 화학(NC=techFild3), 생명과학(LA=5), 보건의료(LC=7), 재료(EB=9), 전기전자(ED=11) — SKILL.md "고정 설정" 표.
 *   공고상태: rcpt_end까지 D-5 이하 → "마감임박", 그 외 → "접수중" (SKILL.md "공고상태 자동 판별").
 *   Notion 페이지는 prepend 위해 부모 데이터소스에 직접 create — 최신 항목이 위로 올라옴.
 */

import { Client as NotionClient } from '@notionhq/client';
import { createNotionClient } from './notion-client.js';
import { env } from '../config/env.js';

// SKILL.md "고정 설정" — Notion DB ID (collection://e7f9a78c-0195-4db7-a3cb-df2047b4a74f)
const IRIS_DB_ID = 'e7f9a78c-0195-4db7-a3cb-df2047b4a74f';

// SKILL의 iris_crawler.py 상수 그대로
const LIST_API = 'https://www.iris.go.kr/contents/retrieveBsnsAncmBtinSituList.do';
const DETAIL_BASE = 'https://www.iris.go.kr/contents/retrieveBsnsAncmDtlView.do';
const TECH_FIELDS = ['techFild3', 'techFild5', 'techFild7', 'techFild9', 'techFild11'];
const REQUEST_DELAY_MS = 200;

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Content-Type': 'application/x-www-form-urlencoded',
  'X-Requested-With': 'XMLHttpRequest',
  Referer: 'https://www.iris.go.kr/contents/retrieveBsnsAncmBtinSituListView.do',
};

// SKILL.md "공모유형 매핑" — IRIS 텍스트 → Notion multi_select 옵션
const ANCM_TYPE_OPTIONS = ['자유공모', '지정공모', '품목지정공모', '분야공모', '정책지정공모'];

interface IrisItem {
  ancmId: string;
  title: string;
  ancm_no: string;
  ancm_date: string;
  rcpt_start: string;
  rcpt_end: string;
  rcpt_period: string;
  dept: string;
  agency: string;
  ancm_type: string;
  status: '접수중' | '마감임박';
  url: string;
}

export interface IrisMonitoringResult {
  totalCrawled: number;
  newProjectsAdded: number;
  skippedExisting: number;
  errors: string[];
  ranAt: string;
}

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

/** '2026.03.11' / '2026-03-11' → 'YYYY-MM-DD' */
function parseDotDate(s: string | undefined): string {
  if (!s) return '';
  const m = s.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** SKILL "공고상태 자동 판별" — D-5 이하 → 마감임박 */
function computeStatus(rcptEnd: string, dDay: number | null | undefined): '접수중' | '마감임박' {
  if (typeof dDay === 'number') {
    return dDay >= 0 && dDay <= 5 ? '마감임박' : '접수중';
  }
  if (!rcptEnd) return '접수중';
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const end = new Date(`${rcptEnd}T00:00:00Z`);
    const delta = Math.round((end.getTime() - today.getTime()) / 86400000);
    return delta >= 0 && delta <= 5 ? '마감임박' : '접수중';
  } catch {
    return '접수중';
  }
}

/** SKILL "공모유형 매핑" — multi_select 배열로 변환 (매칭 안 되면 빈 배열) */
function parseAncmType(raw: string): string[] {
  if (!raw) return [];
  // 여러 유형이 섞인 경우 콤마/슬래시/공백으로 분리하여 각각 매칭
  const tokens = raw.split(/[,\/\s]+/).map(t => t.trim()).filter(Boolean);
  const matched: string[] = [];
  for (const tok of tokens) {
    const hit = ANCM_TYPE_OPTIONS.find(opt => tok.includes(opt));
    if (hit && !matched.includes(hit)) matched.push(hit);
  }
  // 콤마 분리 안 된 단일 문자열인 경우도 커버
  if (matched.length === 0) {
    const hit = ANCM_TYPE_OPTIONS.find(opt => raw.includes(opt));
    if (hit) matched.push(hit);
  }
  return matched;
}

// ── IRIS 크롤링 ──────────────────────────────────────────────────────────────

/** SKILL의 fetch_all_items() — IRIS JSON API 페이지네이션 */
async function fetchAllItems(): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  let totalPages = 1;

  // 안전 가드: 무한 루프 방지
  while (page <= 200) {
    const params = new URLSearchParams();
    params.set('ancmPrg', 'ancmIng');
    params.set('pageIndex', String(page));
    for (const f of TECH_FIELDS) params.set(f, 'on');

    const resp = await fetch(LIST_API, {
      method: 'POST',
      headers: FETCH_HEADERS,
      body: params.toString(),
    });
    if (!resp.ok) {
      throw new Error(`IRIS LIST_API HTTP ${resp.status} (page ${page})`);
    }
    const json = (await resp.json()) as {
      listBsnsAncmBtinSitu?: any[];
      paginationInfo?: { totalPageCount?: number };
    };
    const items = json.listBsnsAncmBtinSitu || [];
    if (items.length === 0) break;
    all.push(...items);
    totalPages = json.paginationInfo?.totalPageCount ?? 1;
    if (page >= totalPages) break;
    page++;
    await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
  }
  return all;
}

/** SKILL의 transform() — IRIS 응답 → 표준 IrisItem */
function transform(raw: any): IrisItem {
  const ancmId = String(raw.ancmId || '');
  let ancmNo = String(raw.ancmNo || '').trim();
  const rcveStr = parseDotDate(raw.rcveStrDe);
  const rcveEnd = parseDotDate(raw.rcveEndDe);
  let rcptPeriod = '';
  if (rcveStr && rcveEnd) rcptPeriod = `${rcveStr} ~ ${rcveEnd}`;
  else if (rcveStr) rcptPeriod = rcveStr;

  const status = computeStatus(rcveEnd, raw.dDay);
  if (!ancmNo) ancmNo = ancmId; // SKILL: ancm_no 비면 ancmId로 대체

  return {
    ancmId,
    title: String(raw.ancmTl || '').trim(),
    ancm_no: ancmNo,
    ancm_date: String(raw.ancmDe || ''),
    rcpt_start: rcveStr,
    rcpt_end: rcveEnd,
    rcpt_period: rcptPeriod,
    dept: String(raw.blngGovdSeNm || '').trim(),
    agency: String(raw.sorgnNm || '').trim(),
    ancm_type: String(raw.pbofrTpSeNmLst || '').trim(),
    status,
    url: `${DETAIL_BASE}?ancmId=${ancmId}`,
  };
}

// ── Notion 측 ────────────────────────────────────────────────────────────────

/**
 * 기존 Notion DB 항목의 공고번호 + ancmId 집합 수집 (중복 방지용).
 * 페이지네이션 모두 순회.
 */
async function fetchExistingKeys(notion: NotionClient): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const resp: any = await notion.databases.query({
      database_id: IRIS_DB_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of resp.results as any[]) {
      const props = p.properties || {};
      const ancmNo = props['공고번호']?.rich_text?.[0]?.plain_text as string | undefined;
      if (ancmNo) keys.add(ancmNo.trim());
      // 상세링크 URL의 ancmId 파라미터도 키로 등록 (ancm_no 비어있던 항목 매칭)
      const detailUrl = props['상세링크']?.url as string | undefined;
      if (detailUrl) {
        const m = detailUrl.match(/ancmId=([^&]+)/);
        if (m) keys.add(m[1]);
      }
    }
    cursor = resp.has_more ? resp.next_cursor || undefined : undefined;
  } while (cursor);
  return keys;
}

/** SKILL "Notion 필드 매핑" 표 그대로 properties 빌드 */
function buildProperties(item: IrisItem): Record<string, any> {
  const props: Record<string, any> = {
    '공고명': { title: [{ text: { content: item.title || '(제목 없음)' } }] },
    '공고번호': { rich_text: [{ text: { content: item.ancm_no } }] },
    '공고상태': { select: { name: item.status } },
    '상세링크': { url: item.url },
  };
  if (item.ancm_date) {
    props['공고일자'] = { date: { start: item.ancm_date } };
  }
  const types = parseAncmType(item.ancm_type);
  if (types.length > 0) {
    props['공모유형'] = { multi_select: types.map(t => ({ name: t })) };
  }
  if (item.dept) {
    props['소관부처'] = { select: { name: item.dept } };
  }
  if (item.agency) {
    props['전문기관'] = { select: { name: item.agency } };
  }
  return props;
}

/** SKILL "content (특이사항)" — 내일/당일 마감 시 경고 블록 */
function buildContentBlocks(item: IrisItem): any[] {
  if (!item.rcpt_end) return [];
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const end = new Date(`${item.rcpt_end}T00:00:00Z`);
    const delta = Math.round((end.getTime() - today.getTime()) / 86400000);
    let text = '';
    if (delta === 1) text = `⚠️ 내일(${item.rcpt_end}) 마감! 즉시 확인하세요.`;
    else if (delta === 0) text = `🚨 오늘(${item.rcpt_end}) 마감!`;
    if (!text) return [];
    return [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
      },
    ];
  } catch {
    return [];
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

/**
 * IRIS 모니터링 메인 함수.
 * cron 또는 manual API endpoint에서 호출.
 */
export async function runIrisMonitoring(): Promise<IrisMonitoringResult> {
  const result: IrisMonitoringResult = {
    totalCrawled: 0,
    newProjectsAdded: 0,
    skippedExisting: 0,
    errors: [],
    ranAt: new Date().toISOString(),
  };

  if (!env.NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY 미설정 — Notion 조회 불가');
  }

  // [1단계] IRIS 크롤링 (실패 시 throw — cron 측에서 alert)
  let rawItems: any[];
  try {
    rawItems = await fetchAllItems();
  } catch (e: any) {
    throw new Error(`IRIS 크롤링 실패: ${e?.message || e}`);
  }
  const items = rawItems.map(transform);
  result.totalCrawled = items.length;

  if (items.length === 0) {
    console.log('[iris-monitoring] 크롤링 결과 0건 — 종료');
    return result;
  }

  // [2단계] 기존 Notion DB 키 집합 조회
  const notion = createNotionClient(env.NOTION_API_KEY); // undici fetch — 'Premature close' 회피
  const existingKeys = await fetchExistingKeys(notion);

  // [3단계] 신규 과제 선별 — 공고번호 또는 ancmId로 매칭
  const newItems = items.filter(it => {
    const k1 = it.ancm_no?.trim();
    const k2 = it.ancmId?.trim();
    if (k1 && existingKeys.has(k1)) return false;
    if (k2 && existingKeys.has(k2)) return false;
    return true;
  });
  result.skippedExisting = items.length - newItems.length;

  if (newItems.length === 0) {
    console.log(
      `[iris-monitoring] crawled=${result.totalCrawled} new=0 skip=${result.skippedExisting} — 신규 과제 없음`,
    );
    return result;
  }

  // [4단계] 신규 과제 Notion DB에 prepend (Notion API는 create 시점이 가장 위)
  // 최신 ancm_date가 위로 오도록 정렬: 오래된 것부터 create해서 최신이 가장 위에 남도록
  newItems.sort((a, b) => (a.ancm_date || '').localeCompare(b.ancm_date || ''));

  for (const item of newItems) {
    try {
      const blocks = buildContentBlocks(item);
      await notion.pages.create({
        parent: { database_id: IRIS_DB_ID } as any,
        properties: buildProperties(item) as any,
        children: blocks.length > 0 ? blocks : undefined,
      });
      result.newProjectsAdded++;
      // Notion rate limit (~3 req/sec)
      await new Promise(r => setTimeout(r, 350));
    } catch (e: any) {
      // 개별 insert 실패는 수집 후 계속 진행
      const msg = `[${item.ancm_no || item.ancmId}] ${item.title}: ${e?.message || e}`;
      result.errors.push(msg);
      console.warn(`[iris-monitoring] insert 실패 — ${msg}`);
    }
  }

  console.log(
    `[iris-monitoring] crawled=${result.totalCrawled} new=${result.newProjectsAdded} ` +
      `skip=${result.skippedExisting} errors=${result.errors.length}`,
  );
  return result;
}
