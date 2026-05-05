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

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  archived: boolean;
  properties: Record<string, any>;
}

async function notionFetch<T>(path: string, opts: { method?: string; body?: any } = {}): Promise<T> {
  if (!env.NOTION_API_KEY) throw new Error('NOTION_API_KEY 미설정');
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${path}: ${res.status} ${await res.text().then(t => t.slice(0, 200))}`);
  return res.json() as Promise<T>;
}

async function queryDb(): Promise<NotionPage[]> {
  const all: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const data: any = await notionFetch(`/databases/${MANUSCRIPT_DB_ID}/query`, {
      method: 'POST',
      body: { page_size: 100, start_cursor: cursor },
    });
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

function getTitle(page: NotionPage): string {
  const titleProp = Object.values(page.properties).find((p: any) => p?.type === 'title') as any;
  return titleProp?.title?.[0]?.plain_text || '(제목 없음)';
}

function getText(page: NotionPage, propName: string): string | null {
  const p = page.properties[propName];
  if (!p) return null;
  if (p.type === 'rich_text') return p.rich_text?.[0]?.plain_text || null;
  if (p.type === 'title') return p.title?.[0]?.plain_text || null;
  return null;
}

function getSelect(page: NotionPage, propName: string): string | null {
  const p = page.properties[propName];
  if (!p) return null;
  if (p.type === 'select') return p.select?.name || null;
  if (p.type === 'status') return p.status?.name || null;
  return null;
}

function getNumber(page: NotionPage, propName: string): number | null {
  const p = page.properties[propName];
  return p?.type === 'number' ? p.number : null;
}

function getDate(page: NotionPage, propName: string): Date | null {
  const p = page.properties[propName];
  if (p?.type !== 'date' || !p.date?.start) return null;
  return new Date(p.date.start);
}

function getUrl(page: NotionPage, propName: string): string | null {
  const p = page.properties[propName];
  return p?.type === 'url' ? p.url : null;
}

/** 메인 sync — 모든 노션 row를 DB로 upsert */
export async function syncManuscripts(): Promise<{ total: number; updated: number; archived: number; errors: number }> {
  const t0 = Date.now();
  const syncStartedAt = new Date();
  console.log('[manuscript-sync] 시작');

  let rows: NotionPage[];
  try {
    rows = await queryDb();
  } catch (e: any) {
    console.error('[manuscript-sync] DB query 실패:', e.message);
    return { total: 0, updated: 0, archived: 0, errors: 1 };
  }
  console.log(`[manuscript-sync] 노션 rows: ${rows.length}`);

  let updated = 0, errors = 0;
  for (const row of rows) {
    try {
      if (row.archived) continue;  // 노션에서 trash 처리된 row 스킵

      const title = getTitle(row);
      const stage = getSelect(row, '단계') || '작성';
      const whoseTurn = getSelect(row, '차례');
      const firstAuthors = getText(row, '1저자 학생');
      const piRole = getSelect(row, 'PI 역할');
      const currentJournal = getText(row, '현재/타겟 저널');
      const impactFactor = getNumber(row, 'Impact Factor');
      const attempts = getNumber(row, '시도 횟수') || 1;
      const rejectHistory = getText(row, '리젝 이력');
      const manuscriptNum = getText(row, 'Manuscript ID');
      const submittedAt = getDate(row, '제출일');
      const revisionDueAt = getDate(row, '리비전 마감');
      const publishedAt = getDate(row, '게재일');
      const doi = getUrl(row, 'DOI');
      const manuscriptPageUrl = getUrl(row, '노션 페이지');
      const lastActivityAt = getDate(row, '마지막 활동') || new Date(row.last_edited_time);
      const lastActivityType = getText(row, '마지막 활동 종류');
      const memo = getText(row, '메모');

      const data = {
        notionUrl: row.url,
        title,
        stage,
        whoseTurn,
        firstAuthors,
        piRole,
        currentJournal,
        impactFactor,
        attempts,
        rejectHistory,
        manuscriptNum,
        submittedAt,
        revisionDueAt,
        publishedAt,
        doi,
        manuscriptPageUrl,
        lastActivityAt,
        lastActivityType,
        memo,
        notionLastEditedAt: new Date(row.last_edited_time),
        archived: false,
        syncedAt: syncStartedAt,
      };

      await prisma.manuscript.upsert({
        where: { id: row.id },
        create: { id: row.id, ...data },
        update: data,
      });
      updated++;
    } catch (err: any) {
      errors++;
      console.error(`[manuscript-sync] FAILED ${row.id}:`, err.message?.slice(0, 100));
    }
  }

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
  properties: Record<string, any>,
): Promise<boolean> {
  try {
    await notionFetch(`/pages/${manuscriptId}`, {
      method: 'PATCH',
      body: { properties },
    });
    return true;
  } catch (e: any) {
    console.warn(`[manuscript-sync] property patch 실패 ${manuscriptId}:`, e.message?.slice(0, 80));
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
    if (m.firstAuthors) {
      for (const name of m.firstAuthors.split(',')) {
        const n = name.trim();
        if (n) firstAuthorSet.add(n);
      }
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
