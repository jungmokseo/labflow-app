import { PrismaClient } from '@prisma/client';
import { fetchAllPages, getTitle, getRichText, getSelect, getMultiSelect, getDate, getNumber, getPeople, getStatus, DB_IDS } from '../notion-client.js';

function mapStatus(notionStatus: string | null): string {
  if (!notionStatus) return 'active';
  const map: Record<string, string> = {
    '수행중': 'active',
    '종료': 'completed',
    '종료임박': 'ending_soon',
    '신규준비중': 'preparing',
    '제출완료': 'submitted',
  };
  return map[notionStatus] ?? 'active';
}

export async function migrateProjects(prisma: PrismaClient, labId: string) {
  const pages = await fetchAllPages(DB_IDS.projects);
  console.log(`📥 수행과제관리 페이지 ${pages.length}개 조회`);

  let count = 0;
  const projectMap: Map<string, string> = new Map(); // name → id

  for (const page of pages) {
    const props = page.properties;
    const name = getTitle(props, '과제명');
    if (!name) continue;

    const period = getDate(props, '과제기간');
    const periodStr = period.start
      ? `${period.start}${period.end ? ` ~ ${period.end}` : ''}`
      : null;

    const managers = getPeople(props, '담당자');
    const status = getStatus(props, '상태') ?? getSelect(props, '상태');

    const project = await prisma.project.create({
      data: {
        labId,
        name,
        number: getRichText(props, '약칭') || null,
        funder: getSelect(props, '발주처') || getRichText(props, '발주처') || null,
        period: periodStr,
        pi: '서정목',
        pm: managers[0] || null,
        status: mapStatus(status),
        confidence: 1.0,
        metadata: {
          projectType: getSelect(props, '과제유형'),
          affiliation: getSelect(props, '소속') || getRichText(props, '소속'),
          agency: getSelect(props, '전문기관') || getRichText(props, '전문기관'),
          annualBudget: getNumber(props, '연간예산'),
          totalBudget: getNumber(props, '총예산'),
          executionRate: getNumber(props, '집행률'),
          reportType: getSelect(props, '보고유형'),
          nextDeadline: getRichText(props, '다음보고마감'),
          deliverables: getRichText(props, '핵심산출물목표'),
          memo: getRichText(props, '메모'),
          managers,
        },
      },
    });
    projectMap.set(name, project.id);
    count++;
  }
  console.log(`✅ Project ${count}개 생성`);
  return { count, projectMap };
}
