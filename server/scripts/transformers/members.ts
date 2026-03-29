import { PrismaClient } from '@prisma/client';
import { fetchAllPages, getTitle, getRichText, getEmail, getPhoneNumber, getDate, DB_IDS } from '../notion-client.js';

export async function migrateMembers(prisma: PrismaClient, labId: string) {
  const pages = await fetchAllPages(DB_IDS.members);
  console.log(`📥 인적사항 페이지 ${pages.length}개 조회`);

  let count = 0;
  for (const page of pages) {
    const props = page.properties;
    const name = getTitle(props, '이름');
    if (!name) continue;

    const birthday = getDate(props, '생년월일');
    const studentId = getRichText(props, '학번');
    const researcherId = getRichText(props, '연구자등록번호');

    await prisma.labMember.create({
      data: {
        labId,
        name,
        email: getEmail(props, '이메일'),
        phone: getPhoneNumber(props, '핸드폰번호'),
        role: '학생',
        active: true,
        confidence: 1.0,
        metadata: {
          birthday: birthday.start,
          studentId: studentId || undefined,
          researcherId: researcherId || undefined,
        },
      },
    });
    count++;
  }
  console.log(`✅ LabMember ${count}명 생성`);
  return count;
}
