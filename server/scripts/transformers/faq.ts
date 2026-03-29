import { PrismaClient } from '@prisma/client';
import { fetchAllPages, getTitle, getRichText, getMultiSelect, getStatus, getSelect, DB_IDS } from '../notion-client.js';

export async function migrateFaq(prisma: PrismaClient, userId: string, labId: string) {
  const pages = await fetchAllPages(DB_IDS.faq);
  console.log(`📥 FAQ 페이지 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;

    // 답변완료 상태인 것만 마이그레이션
    const status = getStatus(props, '상태') ?? getSelect(props, '상태');
    if (status && status !== '답변완료') continue;

    const title = getTitle(props, '질문') || getRichText(props, '질문');
    const content = getRichText(props, '답변');
    if (!title && !content) continue;

    const categories = getMultiSelect(props, '카테고리');
    const keywords = getMultiSelect(props, '키워드');

    await prisma.memo.create({
      data: {
        userId,
        labId,
        title,
        content: content || title,
        tags: [...categories, ...keywords].filter(Boolean),
        source: 'faq',
        shared: true,
        confidence: 1.0,
      },
    });
    count++;
  }
  console.log(`✅ Memo(faq) ${count}개 생성`);
  return count;
}
