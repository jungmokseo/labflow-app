/**
 * Notion 논문 파이프라인 sync — 진행 중 + 게재 완료 통합 캐시.
 *
 * Notion이 source of truth. 매시간 sync로 모든 row를 노션 → DB 캐시.
 * 사용자가 노션에서 직접 카드를 추가/수정/삭제하면 다음 sync에 반영.
 *
 * Gmail 자동 감지 (manuscript-mail-monitor.ts)는 발견된 이벤트를 노션 property에 patch하므로,
 * 다음 sync에서 자동으로 DB 캐시에 반영됨.
 */
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const prisma = new PrismaClient();

const MANUSCRIPT_DB_ID = '06e9070b-661d-4d7d-829f-3aed16dda560';
const NOTION_TIMEOUT_MS = 10_000;
const NOTION_CONCURRENCY = 5;  // Notion API rate limit 3 req/s 대비 안전

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  archived: boolean;
  properties: Record<string, any>;
}

async function notionFetch<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!env.NOTION_API_KEY) throw new Error('NOTION_API_KEY 미설정');
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.stringify(opts.body) : undefined;

  const attempt = async (): Promise<T> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NOTION_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.notion.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${env.NOTION_API_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        const err: Error & { status?: number } = new Error(`Notion ${path}: ${res.status} ${text}`);
        err.status = res.status;
        throw err;
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (e) {
    // 5xx는 1회 재시도. 4xx/timeout/abort 등은 즉시 실패.
    const status = (e as { status?: number }).status;
    if (status && status >= 500 && status < 600) {
      await new Promise(r => setTimeout(r, 500));
      return attempt();
    }
    throw e;
  }
}

async function queryDb(): Promise<NotionPage[]> {
  const all: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const data = await notionFetch<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>(
      `/databases/${MANUSCRIPT_DB_ID}/query`,
      { method: 'POST', body: { page_size: 100, start_cursor: cursor } },
    );
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor || undefined : undefined;
  } while (cursor);
  return all;
}

// ─────────────────────────────────────────────
// Notion property getter — type별 location 분기
// ─────────────────────────────────────────────

function getText(page: NotionPage, name: string): string | null {
  const p = page.properties[name];
  if (!p) return null;
  if (p.type === 'rich_text') return p.rich_text?.[0]?.plain_text || null;
  if (p.type === 'title') return p.title?.[0]?.plain_text || null;
  return null;
}

function getSelect(page: NotionPage, name: string): string | null {
  const p = page.properties[name];
  if (p?.type === 'select') return p.select?.name || null;
  if (p?.type === 'status') return p.status?.name || null;
  return null;
}

function getNumber(page: NotionPage, name: string): number | null {
  const p = page.properties[name];
  return p?.type === 'number' ? p.number : null;
}

function getDate(page: NotionPage, name: string): Date | null {
  const p = page.properties[name];
  return p?.type === 'date' && p.date?.start ? new Date(p.date.start) : null;
}

function getUrl(page: NotionPage, name: string): string | null {
  const p = page.properties[name];
  return p?.type === 'url' ? p.url : null;
}

function getTitle(page: NotionPage): string {
  for (const p of Object.values(page.properties)) {
    if (p?.type === 'title') return p.title?.[0]?.plain_text || '(제목 없음)';
  }
  return '(제목 없음)';
}

/** 노션 row → DB upsert payload */
function rowToData(row: NotionPage, syncStartedAt: Date) {
  return {
    notionUrl: row.url,
    title: getTitle(row),
    stage: getSelect(row, '단계') || '작성',
    whoseTurn: getSelect(row, '차례'),
    firstAuthors: getText(row, '1저자 학생'),
    piRole: getSelect(row, 'PI 역할'),
    currentJournal: getText(row, '현재/타겟 저널'),
    impactFactor: getNumber(row, 'Impact Factor'),
    attempts: getNumber(row, '시도 횟수') || 1,
    rejectHistory: getText(row, '리젝 이력'),
    manuscriptNum: getText(row, 'Manuscript ID'),
    submittedAt: getDate(row, '제출일'),
    revisionDueAt: getDate(row, '리비전 마감'),
    publishedAt: getDate(row, '게재일'),
    doi: getUrl(row, 'DOI'),
    manuscriptPageUrl: getUrl(row, '노션 페이지'),
    lastActivityAt: getDate(row, '마지막 활동') || new Date(row.last_edited_time),
    lastActivityType: getText(row, '마지막 활동 종류'),
    memo: getText(row, '메모'),
    notionLastEditedAt: new Date(row.last_edited_time),
    archived: false as const,
    syncedAt: syncStartedAt,
  };
}

/** 한 row를 upsert. 실패는 (errors++) 호출자가 집계. */
async function upsertRow(row: NotionPage, syncStartedAt: Date): Promise<void> {
  if (row.archived) return;  // 노션 trash row 스킵
  const data = rowToData(row, syncStartedAt);
  await prisma.manuscript.upsert({
    where: { id: row.id },
    create: { id: row.id, ...data },
    update: data,
  });
}

/** N개씩 동시 처리 — Promise.allSettled로 개별 실패 격리 */
async function runConcurrent<T extends { id: string }>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<{ ok: number; errors: number }> {
  let ok = 0, errors = 0;
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));
    settled.forEach((r, j) => {
      if (r.status === 'fulfilled') { ok++; return; }
      errors++;
      const reason = (r.reason as Error)?.message?.slice(0, 100) || String(r.reason);
      console.error(`[manuscript-sync] FAILED ${batch[j].id}: ${reason}`);
    });
  }
  return { ok, errors };
}

/** 메인 sync — 모든 노션 row를 DB로 upsert (concurrency 5) */
export async function syncManuscripts(): Promise<{ total: number; updated: number; archived: number; errors: number }> {
  const t0 = Date.now();
  const syncStartedAt = new Date();
  console.log('[manuscript-sync] 시작');

  let rows: NotionPage[];
  try {
    rows = await queryDb();
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 100) || 'unknown';
    console.error(`[manuscript-sync] FAILED queryDb: ${msg}`);
    return { total: 0, updated: 0, archived: 0, errors: 1 };
  }
  console.log(`[manuscript-sync] 노션 rows: ${rows.length}`);

  const { ok: updated, errors } = await runConcurrent(
    rows,
    NOTION_CONCURRENCY,
    row => upsertRow(row, syncStartedAt),
  );

  // Stale cleanup — 이번 sync에서 업데이트 안 된 row는 노션에서 삭제됐다고 간주 → archived
  const archiveResult = await prisma.manuscript.updateMany({
    where: { syncedAt: { lt: syncStartedAt }, archived: false },
    data: { archived: true },
  });

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[manuscript-sync] 완료: ${updated} upserted, ${archiveResult.count} archived, ${errors} errors, ${elapsed}s`);
  return { total: rows.length, updated, archived: archiveResult.count, errors };
}

/** Notion property 직접 patch — Gmail monitor 등이 호출 */
export async function patchManuscriptProperty(
  manuscriptId: string,
  properties: Record<string, unknown>,
): Promise<boolean> {
  try {
    await notionFetch(`/pages/${manuscriptId}`, {
      method: 'PATCH',
      body: { properties },
    });
    return true;
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 100) || 'unknown';
    console.warn(`[manuscript-sync] FAILED ${manuscriptId}: ${msg}`);
    return false;
  }
}

export async function getManuscripts(opts: { archived?: boolean } = {}) {
  return prisma.manuscript.findMany({
    where: { archived: opts.archived ?? false },
    orderBy: [
      { stage: 'asc' },
      { lastActivityAt: 'desc' },
    ],
  });
}

/** KPI for 게재 완료 view (승진 자료) */
export async function getPublishedKpi() {
  const all = await prisma.manuscript.findMany({
    where: { archived: false, stage: '게재 완료' },
  });
  const thisYear = new Date().getFullYear();
  const corresponding = all.filter(m => m.piRole === '교신');
  const coAuthor = all.filter(m => m.piRole === '공저');
  const thisYearCorresp = corresponding.filter(m => m.publishedAt && m.publishedAt.getFullYear() === thisYear);

  const ifsCorresp = corresponding.map(m => m.impactFactor).filter((x): x is number => x !== null);
  const avgIfCorresp = ifsCorresp.length > 0 ? ifsCorresp.reduce((a, b) => a + b, 0) / ifsCorresp.length : 0;

  // 1저자 학생 unique count
  const firstAuthorSet = new Set<string>();
  for (const m of corresponding) {
    if (!m.firstAuthors) continue;
    for (const name of m.firstAuthors.split(',')) {
      const n = name.trim();
      if (n) firstAuthorSet.add(n);
    }
  }

  return {
    total: all.length,
    correspondingTotal: corresponding.length,
    correspondingThisYear: thisYearCorresp.length,
    coAuthorTotal: coAuthor.length,
    avgImpactFactor: Math.round(avgIfCorresp * 10) / 10,
    uniqueFirstAuthors: firstAuthorSet.size,
  };
}
