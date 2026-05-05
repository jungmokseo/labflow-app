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
// 2026-05-04: LM Paste / LM Thermal Paste가 사용자에 의해 DB의 독립 row로 분리되어
// override 불필요. 새 워크시트 추가 요청 시 여기에 등록.
const WORKSHEET_OVERRIDES: Record<string, string> = {};

// 워크시트로 인식하지 않을 프로젝트 (사용자 명시적 제외)
// 2026-05-04: LM Paste 부모 row(328f9f17...3c2)는 사용자가 ⚪ 미분류로 분류했고
// 실제 워크시트는 LM Paste 2026-03-23(32df...d5) + LM Thermal Paste(33af...ab1) 두 child가
// 독립 DB row로 분리된 상태.
const EXCLUDED_PROJECTS = new Set<string>([
  '328f9f17-6cf4-816f-a4f3-cb703e3ee1bf', // AutoPCB
  '328f9f17-6cf4-813c-9f22-df546a0b63c2', // LM Paste (부모 row, child가 독립 row로 분리됨)
]);

// STANDALONE_WORKSHEETS — 프로젝트 DB와 별개로 직접 등록할 워크시트.
// 2026-05-04: LM Thermal Paste가 DB row로 분리되어 비움. 새 sub-page 워크시트 필요 시 여기에 추가.
const STANDALONE_WORKSHEETS: Array<{
  id: string;
  parentDbPageId: string | null;
  fallbackTitle: string;
  fallbackTeam: string | null;
  fallbackAssignees: string[];
  fallbackStatus: string | null;
}> = [];

interface NotionBlock {
  id: string;
  type: string;
  has_children: boolean;
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

// child를 가질 수 있는 컨테이너 블록 — 재귀 fetch 대상
const CONTAINER_TYPES = new Set([
  'toggle', 'callout', 'quote', 'bulleted_list_item', 'numbered_list_item',
  'to_do', 'column_list', 'column', 'synced_block',
]);

/**
 * 페이지 + child block 재귀 fetch.
 * 워크시트는 toggle/callout 안에 학생 답변이 들어가는 패턴이 흔함 →
 * 최상위만 fetch하면 답변 블록 누락. 재귀로 모든 의미 있는 콘텐츠 수집.
 */
async function getAllBlocksRecursive(
  pageId: string,
  depth = 0,
  maxDepth = 3,
  budget = { remaining: 250 },  // 페이지당 총 fetch 호출 제한
): Promise<NotionBlock[]> {
  if (depth > maxDepth || budget.remaining <= 0) return [];
  budget.remaining--;

  const top = await getPageBlocks(pageId);
  const all: NotionBlock[] = [];
  for (const b of top) {
    all.push(b);
    if (b.has_children && CONTAINER_TYPES.has(b.type) && depth < maxDepth && budget.remaining > 0) {
      const children = await getAllBlocksRecursive(b.id, depth + 1, maxDepth, budget);
      all.push(...children);
    }
  }
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

/** 페이지가 워크시트인지 휴리스틱 판정.
 * 워크시트 = 학생과 PI가 정기적으로 답변/코멘트 누적하는 페이지 (heading 많고 본문 풍부).
 * 단순 to-do list 페이지는 제외 ('📋 현재 액션 아이템' 정확 일치).
 */
function isWorksheet(blocks: NotionBlock[]): { isWorksheet: boolean; reason: string } {
  const h2Count = blocks.filter(b => b.type === 'heading_2').length;
  const h3Count = blocks.filter(b => b.type === 'heading_3').length;
  const headingCount = h2Count + h3Count;
  const childPageCount = blocks.filter(b => b.type === 'child_page').length;
  const firstH2 = getFirstHeading(blocks);

  // 단순 액션 아이템 페이지는 워크시트 아님 (정확 일치만)
  if (firstH2 === '📋 현재 액션 아이템') {
    return { isWorksheet: false, reason: '액션 아이템 페이지' };
  }
  if (childPageCount >= 1) {
    return { isWorksheet: true, reason: `child_page ${childPageCount}개` };
  }
  // 헤딩 많은 페이지 = 워크시트로 판정 (h2+h3 통합 카운트로 점검 노트류도 포함)
  if (headingCount >= 5) {
    return { isWorksheet: true, reason: `긴 분석 워크시트 (h2:${h2Count} h3:${h3Count})` };
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

interface RecentChange {
  blockId: string;
  createdAt: string;       // ISO
  byUserId: string;
  byName: string | null;
  role: string;            // 'PI' | 'STUDENT' | 'OTHER'
  blockType: string;
  text: string;            // 본문 발췌 (200자)
}

interface ActivityInfo {
  lastActivityAt: Date;
  lastActivityBy: string;
  lastActivityByName: string | null;
  lastActivityRole: string;
  lastActivitySnippet: string | null;
  whoseTurn: string;
  studentActivity: Record<string, string>;
  recentChanges: RecentChange[];  // 최근 8개 의미 있는 블록 (시간순 desc)
}

// 무의미한 블록 — 활동 판정 시 제외
const IGNORED_TYPES = new Set([
  'divider', 'child_database', 'child_page', 'unsupported',
  'column_list', 'column', 'synced_block', 'table_of_contents',
  'breadcrumb', 'embed', 'link_preview', 'image', 'video', 'audio',
  'file', 'pdf', 'bookmark',
]);

const MIN_TEXT_LEN = 5;  // 너무 짧은 블록은 의미 없음으로 판정

/**
 * 블록 timeline에서 차례 계산 — created_time 기반.
 *
 * 왜 last_edited_time이 아닌 created_time?
 * Notion에서 누가 블록의 indent 변경 / formatting / paste만 해도 last_edited 갱신됨.
 * 단순 reformat과 의미 있는 콘텐츠 추가가 구분 안 되어 차례 판정이 잘못됨.
 * created_time은 블록 생성 시점이라 변하지 않음 — '누가 새 콘텐츠를 마지막에 추가했는지'를 정확히 알 수 있음.
 */
async function computeActivity(
  blocks: NotionBlock[],
  userMap: Map<string, { name: string; role: string }>,
): Promise<ActivityInfo> {
  // 1. 의미 있는 콘텐츠 블록만 필터 (divider/empty/short 제외)
  const meaningful = blocks.filter(b => {
    if (IGNORED_TYPES.has(b.type)) return false;
    const text = blockText(b);
    return text.length >= MIN_TEXT_LEN;
  });

  // 2. created_time 기준 내림차순 (가장 최근 생성된 블록이 첫 번째)
  const sorted = [...meaningful].sort((a, b) =>
    new Date(b.created_time).getTime() - new Date(a.created_time).getTime(),
  );

  // 3. 학생별 마지막 활동 누적 — 학생이 새로 만든 블록의 created_time 기준
  const studentActivity: Record<string, string> = {};
  for (const b of meaningful) {
    const u = userMap.get(b.created_by.id);
    if (u && u.role === 'STUDENT') {
      if (!studentActivity[u.name] || new Date(b.created_time) > new Date(studentActivity[u.name])) {
        studentActivity[u.name] = b.created_time;
      }
    }
  }

  // 4. 최근 8개 의미 있는 블록 — UI에 timeline으로 표시 (PI ↔ 학생 캐치볼 맥락)
  const recentChanges: RecentChange[] = sorted.slice(0, 8).map(b => {
    const u = userMap.get(b.created_by.id);
    return {
      blockId: b.id,
      createdAt: b.created_time,
      byUserId: b.created_by.id,
      byName: u?.name || null,
      role: u?.role || 'OTHER',
      blockType: b.type,
      text: blockText(b).slice(0, 200),
    };
  });

  // 5. 가장 최근 created 블록의 작성자 = 마지막 활동자
  const last = sorted[0];
  if (!last) {
    return {
      lastActivityAt: new Date(0),
      lastActivityBy: '',
      lastActivityByName: null,
      lastActivityRole: 'OTHER',
      lastActivitySnippet: null,
      whoseTurn: 'PI',
      studentActivity,
      recentChanges: [],
    };
  }

  const lastUser = userMap.get(last.created_by.id);
  const role = lastUser?.role || 'OTHER';
  // 차례 계산: 마지막 활동자가 학생 → PI 차례. PI → 학생 차례. OTHER → PI가 검토할 차례 (기본).
  const whoseTurn = role === 'STUDENT' ? 'PI' : role === 'PI' ? 'STUDENT' : 'PI';

  return {
    lastActivityAt: new Date(last.created_time),
    lastActivityBy: last.created_by.id,
    lastActivityByName: lastUser?.name || null,
    lastActivityRole: role,
    lastActivitySnippet: blockText(last).slice(0, 120),
    whoseTurn,
    studentActivity,
    recentChanges,
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
export async function syncWorksheetProjects(): Promise<{ total: number; worksheets: number; updated: number; errors: number; archived: number }> {
  const t0 = Date.now();
  const syncStartedAt = new Date();
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
        // 사용자가 노션에서 명시적으로 ⏸ 보류로 분류한 row는 워크시트 활성에서 제외.
        // (UI dismiss 버튼이 노션 property를 ⏸ 보류로 갱신 → 다음 sync부터 자동 archived 처리)
        const trackingValue = props['🔬 워크시트 추적']?.select?.name || '';
        const isPaused = trackingValue === '⏸ 보류';
        const archivedFlag = isDone || isPaused;

        // 워크시트 페이지 ID 결정 (override 우선)
        const worksheetPageId = WORKSHEET_OVERRIDES[row.id] || row.id;
        const worksheetPage = WORKSHEET_OVERRIDES[row.id]
          ? await notionFetch<NotionPage>(`/pages/${worksheetPageId}`).catch(() => null)
          : row;

        if (!worksheetPage) return;

        // 0. Early-out 캐시: 노션의 last_edited_time이 마지막 sync 시점 이후 변경 없으면
        //    재귀 fetch 생략. 매시간 cron 중 ~80%는 변경 없음 → Notion API 호출 대폭 절감.
        const existing = await prisma.worksheetProject.findUnique({
          where: { id: worksheetPageId },
          select: { notionLastEditedAt: true, archived: true },
        });
        const newNotionTs = new Date(worksheetPage.last_edited_time);
        if (existing && existing.notionLastEditedAt >= newNotionTs && existing.archived === archivedFlag) {
          // 변경 없음 (notion 갱신 + archived flag 동일) — syncedAt만 갱신해서 stale 처리 안 되게
          await prisma.worksheetProject.update({
            where: { id: worksheetPageId },
            data: { syncedAt: new Date() },
          });
          worksheets++;
          updated++;
          return;
        }

        // 1. 워크시트 판정용 — top-level 블록 1차 조회 (가벼움)
        const topBlocks = await getPageBlocks(worksheetPageId);
        const { isWorksheet: isWS } = isWorksheet(topBlocks);
        if (!isWS) return;
        worksheets++;

        // 2. 활동 계산용 — 재귀 fetch (toggle/callout/quote child 포함)
        // 워크시트는 토글 안에 학생 답변이 들어가는 경우가 흔해서 재귀가 필수.
        const blocks = await getAllBlocksRecursive(worksheetPageId);

        // 본 적 없는 user_id 자동 등록 (created_by + last_edited_by 모두 검사)
        const unknownUserIds = new Set<string>();
        for (const b of blocks) {
          if (b.created_by?.id && !userMap.has(b.created_by.id)) unknownUserIds.add(b.created_by.id);
          if (b.last_edited_by?.id && !userMap.has(b.last_edited_by.id)) unknownUserIds.add(b.last_edited_by.id);
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
            recentChanges: activity.recentChanges as any,
            archived: archivedFlag,
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
            recentChanges: activity.recentChanges as any,
            archived: archivedFlag,
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

  // STANDALONE_WORKSHEETS — 프로젝트 DB와 별개로 등록된 워크시트 처리
  for (const sw of STANDALONE_WORKSHEETS) {
    try {
      // 1. 노션 페이지 fetch 시도 (권한 있으면 메타 + 활동 갱신)
      let title = sw.fallbackTitle;
      let team = sw.fallbackTeam;
      let assignees = sw.fallbackAssignees;
      let status = sw.fallbackStatus;
      let notionLastEditedAt = new Date();
      let activity: ActivityInfo | null = null;
      let notionUrl = `https://www.notion.so/${sw.id.replace(/-/g, '')}`;

      try {
        const page: any = await notionFetch(`/pages/${sw.id}`);
        notionLastEditedAt = new Date(page.last_edited_time);
        notionUrl = page.url || notionUrl;

        // early-out 캐시
        const existing = await prisma.worksheetProject.findUnique({
          where: { id: sw.id },
          select: { notionLastEditedAt: true, archived: true },
        });
        if (existing && existing.notionLastEditedAt >= notionLastEditedAt && !existing.archived) {
          await prisma.worksheetProject.update({
            where: { id: sw.id },
            data: { syncedAt: new Date() },
          });
          worksheets++;
          continue;
        }

        // 블록 fetch + 활동 계산
        const blocks = await getAllBlocksRecursive(sw.id);
        const unknownUserIds = new Set<string>();
        for (const b of blocks) {
          if (b.created_by?.id && !userMap.has(b.created_by.id)) unknownUserIds.add(b.created_by.id);
          if (b.last_edited_by?.id && !userMap.has(b.last_edited_by.id)) unknownUserIds.add(b.last_edited_by.id);
        }
        for (const uid of unknownUserIds) await ensureNotionUser(uid, userMap);
        activity = await computeActivity(blocks, userMap);
      } catch (err: any) {
        // 권한 없음 (404) — fallback 메타로 placeholder 등록 (사용자가 invite 후 자동 갱신)
        console.log(`[worksheet-sync] standalone ${sw.id} 권한 없음 → fallback 사용`);
      }

      const upsertData: any = {
        notionUrl,
        title,
        team,
        assignees,
        status,
        notionLastEditedAt,
        archived: false,
        syncedAt: new Date(),
        ...(activity ? {
          lastActivityAt: activity.lastActivityAt,
          lastActivityBy: activity.lastActivityBy,
          lastActivityByName: activity.lastActivityByName,
          lastActivityRole: activity.lastActivityRole,
          lastActivitySnippet: activity.lastActivitySnippet,
          whoseTurn: activity.whoseTurn,
          daysSinceTurn: Math.floor((Date.now() - activity.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24)),
          studentActivity: activity.studentActivity,
          recentChanges: activity.recentChanges as any,
        } : {
          // 권한 없을 때 — 기본값 (PI 차례로 시작, 사용자가 invite 후 갱신)
          lastActivityAt: notionLastEditedAt,
          lastActivityBy: '',
          lastActivityByName: 'Integration 권한 필요',
          lastActivityRole: 'OTHER',
          lastActivitySnippet: '⚠️ 노션 페이지에 Claude Code Integration을 추가해주세요. 추가 후 다음 sync에서 자동 갱신됩니다.',
          whoseTurn: 'PI',
          daysSinceTurn: 0,
          studentActivity: {},
          recentChanges: [],
        }),
      };

      await prisma.worksheetProject.upsert({
        where: { id: sw.id },
        create: { id: sw.id, parentDbPageId: sw.parentDbPageId, ...upsertData },
        update: { ...upsertData, parentDbPageId: sw.parentDbPageId },
      });
      worksheets++;
      updated++;
    } catch (err: any) {
      errors++;
      console.error(`[worksheet-sync] STANDALONE FAILED ${sw.id}:`, err.message?.slice(0, 100));
    }
  }

  // Stale cleanup
  const archiveResult = await prisma.worksheetProject.updateMany({
    where: { syncedAt: { lt: syncStartedAt }, archived: false },
    data: { archived: true },
  });

  // 활성 워크시트 ID set — 노션 property 분류용 (DB row id 기준)
  const dbActiveWorksheets = await prisma.worksheetProject.findMany({
    where: { archived: false },
    select: { id: true, parentDbPageId: true },
  });
  const activeWorksheetIds = new Set<string>();
  for (const w of dbActiveWorksheets) {
    activeWorksheetIds.add(w.id);
    if (w.parentDbPageId) activeWorksheetIds.add(w.parentDbPageId);  // sub-page workflow 처리
  }

  // ── 노션 DB property 자동 분류 ──────────────────────────
  // 매 sync마다 모든 프로젝트 row의 "🔬 워크시트 추적" property 갱신:
  //  🟢 활성 — 활성 워크시트 (DB worksheet_projects에 archived=false)
  //  ✅ 완료 — status가 "11.게재완료"
  //  ⏸ 보류 — 사용자가 manual로 표시한 값 (덮어쓰지 않음)
  //  ⚪ 미분류 — 그 외 (사용자가 ⏸ 보류로 수동 변경 가능)
  let propertyUpdated = 0;
  await Promise.all(projectRows.map(async (row) => {
    try {
      const status = row.properties['상태']?.status?.name || row.properties['상태']?.select?.name || '';
      const currentTracking = row.properties['🔬 워크시트 추적']?.select?.name || '';
      const isActive = activeWorksheetIds.has(row.id);
      const isCompleted = status.includes('11.') || status.includes('게재완료');

      let newValue: string;
      if (isActive) newValue = '🟢 활성';
      else if (isCompleted) newValue = '✅ 완료';
      else if (currentTracking === '⏸ 보류') newValue = '⏸ 보류';  // 사용자 수동 보존
      else newValue = '⚪ 미분류';

      if (currentTracking === newValue) return;  // 이미 같음 — skip

      await notionFetch(`/pages/${row.id}`, {
        method: 'PATCH',
        body: {
          properties: {
            '🔬 워크시트 추적': { select: { name: newValue } },
          },
        },
      });
      propertyUpdated++;
    } catch (err: any) {
      console.warn(`[worksheet-sync] property 갱신 실패 ${row.id}:`, err.message?.slice(0, 80));
    }
  }));

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[worksheet-sync] 완료: ${worksheets} worksheets, ${updated} upserted, ${errors} errors, ${archiveResult.count} stale archived, property updated: ${propertyUpdated}, ${elapsed}s`);
  return { total: projectRows.length, worksheets, updated, errors, archived: archiveResult.count };
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
