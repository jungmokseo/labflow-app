import { PrismaClient } from '@prisma/client';
import { fetchAllPages, getTitle, getRichText, getDate, getNumber, DB_IDS } from '../notion-client.js';

export async function migrateVacations(prisma: PrismaClient, userId: string) {
  const pages = await fetchAllPages(DB_IDS.vacations);
  console.log(`📥 휴가 페이지 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const name = getTitle(props, '이름') || getRichText(props, '이름');
    if (!name) continue;

    const dateRange = getDate(props, '기간') ?? getDate(props, '휴가기간');
    const startDate = dateRange.start ?? '';
    const endDate = dateRange.end ?? startDate;
    const days = getNumber(props, '일수');
    const annualDays = getNumber(props, '연간할당');
    const memo = getRichText(props, '메모');

    await prisma.memo.create({
      data: {
        userId,
        title: `휴가: ${name} (${startDate}~${endDate})`,
        content: `${name}의 휴가. 기간: ${startDate}~${endDate}, ${days ?? '?'}일. 연간할당: ${annualDays ?? '?'}일. 메모: ${memo || '없음'}`,
        tags: ['vacation', name],
        source: 'vacation',
        shared: true,
        confidence: 1.0,
      },
    });
    count++;
  }
  console.log(`✅ Memo(vacation) ${count}개 생성`);
  return count;
}
