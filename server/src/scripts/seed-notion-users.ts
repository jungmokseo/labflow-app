/**
 * Notion 워크스페이스의 모든 user를 fetch해 NotionUser 테이블에 seed.
 * - PI 1명 (서정목, jungmok.seo@gmail.com)을 'PI' role로 표시
 * - 나머지 person 타입은 'STUDENT' 기본
 * - bot 타입은 skip
 *
 * Usage: npx tsx src/scripts/seed-notion-users.ts
 */
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

const prisma = new PrismaClient();
const PI_EMAIL = 'jungmok.seo@gmail.com';

interface NotionPerson {
  object: 'user';
  id: string;
  type: 'person' | 'bot';
  name: string | null;
  person?: { email: string };
}

async function fetchAllNotionUsers(token: string): Promise<NotionPerson[]> {
  const all: NotionPerson[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL('https://api.notion.com/v1/users');
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
      },
    });
    if (!res.ok) throw new Error(`Notion users API: ${res.status}`);
    const data: any = await res.json();
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return all;
}

async function main() {
  if (!env.NOTION_API_KEY) throw new Error('NOTION_API_KEY 미설정');

  console.log('Notion users API 호출...');
  const users = await fetchAllNotionUsers(env.NOTION_API_KEY);
  console.log(`총 ${users.length}명 fetch (person + bot)`);

  let upserted = 0, skipped = 0;
  for (const u of users) {
    if (u.type !== 'person') { skipped++; continue; }
    const email = u.person?.email || null;
    const role = email === PI_EMAIL ? 'PI' : 'STUDENT';

    await prisma.notionUser.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        name: u.name || '',
        email,
        role,
        studentName: role === 'STUDENT' ? (u.name || '').trim() : null,
        active: true,
      },
      update: {
        name: u.name || '',
        email,
        // role은 한 번 정해지면 update에서 덮어쓰지 않음 (수동 변경 보존)
      },
    });
    upserted++;
  }

  console.log(`upserted: ${upserted}, skipped (bot): ${skipped}`);

  // 검증: PI 1명 확인
  const piCount = await prisma.notionUser.count({ where: { role: 'PI' } });
  console.log(`PI: ${piCount}, STUDENT: ${await prisma.notionUser.count({ where: { role: 'STUDENT' } })}`);
  if (piCount === 0) console.warn('⚠️ PI(서정목) 발견 안 됨 — Notion 워크스페이스 권한 확인');
}

main().catch(console.error).finally(() => prisma.$disconnect());
