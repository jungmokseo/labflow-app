import { PrismaClient } from '@prisma/client';
import { fetchAllPages, getTitle, getRichText, DB_IDS } from '../notion-client.js';

export async function migrateAccounts(prisma: PrismaClient, userId: string) {
  const pages = await fetchAllPages(DB_IDS.accounts);
  console.log(`📥 계정정보 페이지 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const company = getTitle(props, '업체명') || getRichText(props, '업체명');
    if (!company) continue;

    const username = getRichText(props, '아이디');
    const password = getRichText(props, '비밀번호');
    const note = getRichText(props, '비고');

    await prisma.memo.create({
      data: {
        userId,
        title: company,
        content: `업체: ${company}, 아이디: ${username}, 비밀번호: ${password}. 비고: ${note || '없음'}`,
        tags: ['account', company],
        source: 'account',
        shared: false,
        confidence: 1.0,
      },
    });
    count++;
  }
  console.log(`✅ Memo(account) ${count}개 생성`);
  return count;
}
