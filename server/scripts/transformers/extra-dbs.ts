/**
 * 추가 5개 Notion DB → Supabase 마이그레이션
 * - BLISS Lab 프로젝트 → Memo (source: 'lab-project')
 * - 빠른 메모 저장소 → Memo (source: 'quick-memo')
 * - Jarvis 과제 정보 → Memo (source: 'project-info') — 기존 Project와 별도 상세정보
 * - 아이디어 박스 → Capture (category: IDEA)
 * - 인박스 테스크 → Capture (category: TASK)
 */
import { PrismaClient } from '@prisma/client';
import {
  fetchAllPages, getTitle, getRichText, getSelect, getMultiSelect,
  getDate, getCheckbox,
} from '../notion-client.js';

const EXTRA_DB_IDS = {
  labProjects: '37e9d1e2155a4f1a8a17a12f271f8c7d',
  quickMemo: 'ea8083d433c64920a031a8257322494b',
  jarvisProject: 'b4e01f852e14447ca165cf1894602623',
  ideaBox: '9da9d2f425744252 9ad3f1a4a90398de'.replace(' ', ''),
  inbox: '7ff177bcb309491584b96c0003242780',
};

// ── 1. BLISS Lab 프로젝트 → Memo ──
export async function migrateLabProjects(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(EXTRA_DB_IDS.labProjects);
  console.log(`📥 BLISS Lab 프로젝트 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const name = getTitle(props, '프로젝트명');
    if (!name) continue;

    const status = getSelect(props, '상태') || '진행중';
    const priority = getSelect(props, '우선순위') || '';
    const targetJournal = getRichText(props, '타겟 저널');
    const relatedProjects = getMultiSelect(props, '관련 과제');
    const team = getSelect(props, '팀') || '';
    const type = getSelect(props, '유형') || '';
    const memo = getRichText(props, '메모');
    const managers = getMultiSelect(props, '담당자');
    const deadline = getDate(props, '제출 목표일');
    const done = getCheckbox(props, '완료?');

    const content = [
      `프로젝트: ${name}`,
      `상태: ${status}${done ? ' (완료)' : ''}`,
      priority ? `우선순위: ${priority}` : '',
      type ? `유형: ${type}` : '',
      team ? `팀: ${team}` : '',
      targetJournal ? `타겟 저널: ${targetJournal}` : '',
      relatedProjects.length > 0 ? `관련 과제: ${relatedProjects.join(', ')}` : '',
      managers.length > 0 ? `담당자: ${managers.join(', ')}` : '',
      deadline.start ? `제출 목표일: ${deadline.start}` : '',
      memo ? `메모: ${memo}` : '',
    ].filter(Boolean).join('\n');

    const tags = ['lab-project', status, ...relatedProjects].filter(Boolean);

    await prisma.memo.create({
      data: {
        userId,
        labId,
        title: `🔬 ${name}`,
        content,
        tags,
        source: 'lab-project',
        shared: true,
      },
    });
    count++;
  }
  console.log(`✅ Memo(lab-project) ${count}개 생성`);
  return count;
}

// ── 2. 빠른 메모 저장소 → Memo ──
export async function migrateQuickMemos(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(EXTRA_DB_IDS.quickMemo);
  console.log(`📥 빠른 메모 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const title = getTitle(props, '메모');
    if (!title) continue;

    const content = getRichText(props, '내용');
    const tags = getMultiSelect(props, '태그');
    const dateInfo = getDate(props, '날짜');

    await prisma.memo.create({
      data: {
        userId,
        labId,
        title: `💡 ${title}`,
        content: content || title,
        tags: ['quick-memo', ...tags],
        source: 'quick-memo',
        shared: false,
      },
    });
    count++;
  }
  console.log(`✅ Memo(quick-memo) ${count}개 생성`);
  return count;
}

// ── 3. Jarvis 과제 정보 → Memo (상세 과제 정보) ──
export async function migrateJarvisProjects(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(EXTRA_DB_IDS.jarvisProject);
  console.log(`📥 Jarvis 과제 정보 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const name = getTitle(props, '과제명');
    if (!name) continue;

    const bizName = getRichText(props, '사업명');
    const agency = getRichText(props, '전문기관명');
    const category = getSelect(props, '구분') || '';
    const manager = getRichText(props, '담당자');
    const period = getRichText(props, '과제기간');

    const content = [
      `과제명: ${name}`,
      bizName ? `사업명: ${bizName}` : '',
      agency ? `전문기관: ${agency}` : '',
      category ? `구분: ${category}` : '',
      manager ? `담당자: ${manager}` : '',
      period ? `과제기간: ${period}` : '',
    ].filter(Boolean).join('\n');

    await prisma.memo.create({
      data: {
        userId,
        labId,
        title: `📋 ${name.slice(0, 60)}`,
        content,
        tags: ['project-info', category].filter(Boolean),
        source: 'project-info',
        shared: true,
      },
    });
    count++;
  }
  console.log(`✅ Memo(project-info) ${count}개 생성`);
  return count;
}

// ── 4. 아이디어 박스 → Capture (IDEA) ──
export async function migrateIdeaBox(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(EXTRA_DB_IDS.ideaBox);
  console.log(`📥 아이디어 박스 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const title = getTitle(props, '아이디어');
    if (!title) continue;

    const memo = getRichText(props, '메모');
    const source = getSelect(props, '출처') || '';
    const categories = getMultiSelect(props, '카테고리');

    await prisma.capture.create({
      data: {
        userId,
        labId,
        content: memo ? `${title}\n\n${memo}` : title,
        summary: title.slice(0, 100),
        category: 'IDEA',
        tags: ['idea', ...categories],
        priority: 'MEDIUM',
        confidence: 1.0,
        sourceType: 'notion-import',
        status: 'active',
        modelUsed: 'notion-import',
      },
    });
    count++;
  }
  console.log(`✅ Capture(idea) ${count}개 생성`);
  return count;
}

// ── 5. 인박스 테스크 → Capture (TASK) ──
export async function migrateInbox(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(EXTRA_DB_IDS.inbox);
  console.log(`📥 인박스 테스크 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const title = getTitle(props, '제목');
    if (!title) continue;

    const urgency = getSelect(props, '긴급도') || '';
    const status = getSelect(props, '상태') || '';
    const deadline = getDate(props, '마감일');
    const requester = getRichText(props, '요청자');
    const original = getRichText(props, '원문');
    const source = getSelect(props, '출처') || '';

    const priorityMap: Record<string, string> = {
      '긴급': 'HIGH', '높음': 'HIGH', '보통': 'MEDIUM', '낮음': 'LOW',
    };
    const priority = priorityMap[urgency] || 'MEDIUM';

    const isDone = status === '완료' || status === '처리완료';

    await prisma.capture.create({
      data: {
        userId,
        labId,
        content: original ? `${title}\n\n${original}` : title,
        summary: title.slice(0, 100),
        category: 'TASK',
        tags: ['task', source, urgency].filter(Boolean),
        priority,
        confidence: 1.0,
        sourceType: 'notion-import',
        status: isDone ? 'completed' : 'active',
        completed: isDone,
        completedAt: isDone ? new Date() : null,
        actionDate: deadline.start ? new Date(deadline.start) : null,
        modelUsed: 'notion-import',
      },
    });
    count++;
  }
  console.log(`✅ Capture(task) ${count}개 생성`);
  return count;
}
