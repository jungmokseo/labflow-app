import { PrismaClient } from '@prisma/client';
import { fetchAllPages, getTitle, getRichText, DB_IDS } from '../notion-client.js';

export async function migrateRegulations(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(DB_IDS.regulations);
  console.log(`📥 규정/매뉴얼 페이지 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const title = getTitle(props, '제목') || getRichText(props, '제목');
    const content = getRichText(props, '내용');
    if (!title && !content) continue;

    const docName = getRichText(props, '문서명');
    const section = getRichText(props, '섹션');

    await prisma.memo.create({
      data: {
        userId,
        labId,
        title,
        content: content || title,
        tags: ['regulation', docName, section].filter(Boolean),
        source: 'regulation',
        shared: true,
        confidence: 1.0,
      },
    });
    count++;
  }
  console.log(`✅ Memo(regulation) ${count}개 생성`);
  return count;
}
