/**
 * Notion 워크시트 프로젝트 sync — PI ↔ 학생 캐치볼 추적.
 *
 * 1. 프로젝트 DB query → 모든 row + 각 행의 (a) page 메타 (b) child blocks
 * 2. 자동 식별: 워크시트 패턴(heading_2 ≥ 5 또는 child_page ≥ 1) → worksheet 등록
 *    - 수동 매핑: WORKSHEET_OVERRIDES (LM Paste 같이 sub-page를 워크시트로 지정)
 * 3. 각 워크시트의 가장 최근 블록 수정자 추출 → whoseTurn 계산
 * 4. WorksheetProject upsert + studentActivity 누적
 *
 * 비용: Notion API 호출 (~50회/sync), DB upsert 15회. AI 호출 없음 (현재 상황 요약은 별도 단계).
 */
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const prisma = new PrismaClient();

const PROJECT_DB_ID = '37e9d1e2-155a-4f1a-8a17-a12f271f8c7d';

// 수동 매핑: 프로젝트 DB row id → 실제 워크시트 sub-page id
// LM Paste 같은 경우 부모 페이지가 아닌 특정 child page를 워크시트로 사용
const WORKSHEET_OVERRIDES: Record<string, string> = {
  // LM Paste (DB row) → 'LM Paste 2026-03-23' sub-page
  '328f9f17-6cf4-813c-9f22-df546a0b63c2': '32df9f17-6cf4-8176-ad6c-d3677e7465d5',
};

// 워크시트로 인식하지 않을 프로젝트 (사용자 명시적 제외)
const EXCLUDED_PROJECTS = new Set<string>([
  '328f9f17-6cf4-816f-a4f3-cb703e3ee1bf', // AutoPCB
]);

interface NotionBlock {
  id: string;
  type: string;
  created_time: string;
  created_by: { id: string };
  last_edited_time: string;
  last_edited_by: { id: string };
  [key: string]: any;
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
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

async function queryProjectDb(): Promise<NotionPage[]> {
  const all: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const data: any = await notionFetch(`/databases/${PROJECT_DB_ID}/query`, {
      method: 'POST',
      body: { page_size: 100, start_cursor: cursor },
    });
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function getPageBlocks(pageId: string, maxBlocks = 200): Promise<NotionBlock[]> {
  const all: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const url = `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const data: any = await notionFetch(url);
    all.push(...data.results);
    cursor = data.has_more && all.length < maxBlocks ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

/** 첫 헤딩 텍스트 추출 (워크시트 패턴 식별용) */
function getFirstHeading(blocks: NotionBlock[]): string {
  for (const b of blocks) {
    if (b.type === 'heading_2') return b.heading_2?.rich_text?.[0]?.plain_text || '';
    if (b.type === 'heading_1') return b.heading_1?.rich_text?.[0]?.plain_text || '';
  }
  return '';
}

/** 페이지가 워크시트인지 휴리스틱 판정 */
function isWorksheet(blocks: NotionBlock[]): { isWorksheet: boolean; reason: string } {
  const h2Count = blocks.filter(b => b.type === 'heading_2').length;
  const childPageCount = blocks.filter(b => b.type === 'child_page').length;
  const firstH2 = getFirstHeading(blocks);

  if (childPageCount >= 1) {
    return { isWorksheet: true, reason: `child_page ${childPageCount}개` };
  }
  if (firstH2 !== '📋 현재 액션 아이템' && !firstH2.startsWith('📋') && h2Count >= 5) {
    return { isWorksheet: true, reason: `긴 분석 워크시트 (h2:${h2Count})` };
  }
  return { isWorksheet: false, reason: '' };
}

/** 블록에서 텍스트 추출 (snippet용) */
function blockText(b: NotionBlock): string {
  const types = ['paragraph', 'bulleted_list_item', 'numbered_list_item', 'heading_1', 'heading_2', 'heading_3', 'quote', 'callout', 'to_do', 'toggle'];
  for (const t of types) {
    const rt = b[t]?.rich_text;
    if (Array.isArray(rt) && rt.length > 0) return rt.map((r: any) => r.plain_text || '').join('').trim();
  }
  return '';
}

interface ActivityInfo {
  lastActivityAt: Date;
  lastActivityBy: string;
  lastActivityByName: string | null;
  lastActivityRole: string;
  lastActivitySnippet: string | null;
  whoseTurn: string;
  studentActivity: Record<string, string>;
}

/** 블록 timeline에서 활동 정보 + 차례 계산 */
async function computeActivity(
  blocks: NotionBlock[],
  userMap: Map<string, { name: string; role: string }>,
): Promise<ActivityInfo> {
  // 사람 활동만 필터 (bot 자동 편집 제외 시 향후 확장)
  const sorted = [...blocks].sort((a, b) =>
    new Date(b.last_edited_time).getTime() - new Date(a.last_edited_time).getTime(),
  );

  // 학생별 마지막 활동 누적
  const studentActivity: Record<string, string> = {};
  for (const b of sorted) {
    const u = userMap.get(b.last_edited_by.id);
    if (u && u.role === 'STUDENT') {
      if (!studentActivity[u.name] || new Date(b.last_edited_time) > new Date(studentActivity[u.name])) {
        studentActivity[u.name] = b.last_edited_time;
      }
    }
  }

  const last = sorted[0];
  const lastUser = last ? userMap.get(last.last_edited_by.id) : undefined;
  const role = lastUser?.role || 'OTHER';
  const whoseTurn = role === 'STUDENT' ? 'PI' : role === 'PI' ? 'STUDENT' : 'PI';

  return {
    lastActivityAt: last ? new Date(last.last_edited_time) : new Date(0),
    lastActivityBy: last?.last_edited_by.id || '',
    lastActivityByName: lastUser?.name || null,
    lastActivityRole: role,
    lastActivitySnippet: last ? blockText(last).slice(0, 120) : null,
    whoseTurn,
    studentActivity,
  };
}

/**
 * 알 수 없는 user_id 발견 시 Notion에서 fetch해 자동 등록.
 * Integration이 보지 못하는 학생들도 워크시트 페이지에서 발견되면 자동으로 NotionUser에 추가.
 */
async function ensureNotionUser(
  userId: string,
  userMap: Map<string, { name: string; role: string }>,
): Promise<void> {
  if (userMap.has(userId)) return;
  try {
    const u: any = await notionFetch(`/users/${userId}`);
    if (u.type !== 'person') return;
    const email = u.person?.email || null;
    const role = email === 'jungmok.seo@gmail.com' ? 'PI' : 'STUDENT';
    await prisma.notionUser.upsert({
      where: { id: userId },
      create: {
        id: userId,
        name: u.name || '',
        email,
        role,
        studentName: role === 'STUDENT' ? (u.name || '').trim() : null,
        active: true,
      },
      update: { name: u.name || '', email },
    });
    userMap.set(userId, { name: u.name || '', role });
    console.log(`[worksheet-sync] new user discovered: ${u.name} (${role})`);
  } catch {
    // 권한 없으면 무시
  }
}

/** 메인 sync */
export async function syncWorksheetProjects(): Promise<{ total: number; worksheets: number; updated: number; errors: number }> {
  const t0 = Date.now();
  console.log('[worksheet-sync] 시작');

  // 1. PI/학생 매핑 로드
  const users = await prisma.notionUser.findMany();
  const userMap = new Map(users.map(u => [u.id, { name: u.name, role: u.role }]));
  console.log(`[worksheet-sync] users 로드: ${users.length}명`);

  // 2. 프로젝트 DB query
  const projectRows = await queryProjectDb();
  console.log(`[worksheet-sync] 프로젝트 DB rows: ${projectRows.length}`);

  let worksheets = 0, updated = 0, errors = 0;

  // 3. 각 row 처리 (병렬, 5개씩)
  const concurrency = 5;
  for (let i = 0; i < projectRows.length; i += concurrency) {
    const batch = projectRows.slice(i, i + concurrency);
    await Promise.all(batch.map(async (row) => {
      try {
        if (EXCLUDED_PROJECTS.has(row.id)) return;
        const props = row.properties;
        const isDone = props['완료?']?.checkbox === true;

        // 워크시트 페이지 ID 결정 (override 우선)
        const worksheetPageId = WORKSHEET_OVERRIDES[row.id] || row.id;
        const worksheetPage = WORKSHEET_OVERRIDES[row.id]
          ? await notionFetch<NotionPage>(`/pages/${worksheetPageId}`).catch(() => null)
          : row;

        if (!worksheetPage) return;

        // 블록 fetch (워크시트인지 판정 + 활동 계산)
        const blocks = await getPageBlocks(worksheetPageId);
        const { isWorksheet: isWS } = isWorksheet(blocks);
        if (!isWS) return;
        worksheets++;

        // 본 적 없는 user_id 자동 등록 (강민경, Soo A Kim 같은 학생들)
        const unknownUserIds = new Set<string>();
        for (const b of blocks) {
          if (!userMap.has(b.last_edited_by.id)) unknownUserIds.add(b.last_edited_by.id);
          if (!userMap.has(b.created_by.id)) unknownUserIds.add(b.created_by.id);
        }
        for (const uid of unknownUserIds) {
          await ensureNotionUser(uid, userMap);
        }

        const title = props['프로젝트명']?.title?.[0]?.plain_text || '(제목 없음)';
        const team = props['팀']?.select?.name || null;
        const assignees = props['담당자']?.multi_select?.map((s: any) => s.name) || [];
        const status = props['상태']?.status?.name || props['상태']?.select?.name || null;

        const activity = await computeActivity(blocks, userMap);
        const daysSinceTurn = Math.floor((Date.now() - activity.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24));

        const url = WORKSHEET_OVERRIDES[row.id]
          ? `https://www.notion.so/${worksheetPageId.replace(/-/g, '')}`
          : row.url;

        await prisma.worksheetProject.upsert({
          where: { id: worksheetPageId },
          create: {
            id: worksheetPageId,
            notionUrl: url,
            parentDbPageId: WORKSHEET_OVERRIDES[row.id] ? row.id : null,
            title,
            team,
            assignees,
            status,
            notionLastEditedAt: new Date(worksheetPage.last_edited_time),
            lastActivityAt: activity.lastActivityAt,
            lastActivityBy: activity.lastActivityBy,
            lastActivityByName: activity.lastActivityByName,
            lastActivityRole: activity.lastActivityRole,
            lastActivitySnippet: activity.lastActivitySnippet,
            whoseTurn: activity.whoseTurn,
            daysSinceTurn,
            studentActivity: activity.studentActivity,
            archived: isDone,
            syncedAt: new Date(),
          },
          update: {
            notionUrl: url,
            title,
            team,
            assignees,
            status,
            notionLastEditedAt: new Date(worksheetPage.last_edited_time),
            lastActivityAt: activity.lastActivityAt,
            lastActivityBy: activity.lastActivityBy,
            lastActivityByName: activity.lastActivityByName,
            lastActivityRole: activity.lastActivityRole,
            lastActivitySnippet: activity.lastActivitySnippet,
            whoseTurn: activity.whoseTurn,
            daysSinceTurn,
            studentActivity: activity.studentActivity,
            archived: isDone,
            syncedAt: new Date(),
          },
        });
        updated++;
      } catch (err: any) {
        errors++;
        console.error(`[worksheet-sync] FAILED ${row.id}:`, err.message?.slice(0, 100));
      }
    }));
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[worksheet-sync] 완료: ${worksheets} worksheets, ${updated} upserted, ${errors} errors, ${elapsed}s`);
  return { total: projectRows.length, worksheets, updated, errors };
}

export async function getWorksheetProjects(opts: { archived?: boolean } = {}) {
  return prisma.worksheetProject.findMany({
    where: { archived: opts.archived ?? false },
    orderBy: [
      { whoseTurn: 'asc' },  // 'PI'가 알파벳 먼저 → 내 차례가 위
      { lastActivityAt: 'desc' },
    ],
  });
}
