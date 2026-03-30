/**
 * 추가 5개 Notion DB → Supabase 마이그레이션
 * 실행: npx tsx scripts/migrate-extra.ts
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

import { migrateLabProjects, migrateQuickMemos, migrateJarvisProjects, migrateIdeaBox, migrateInbox } from './transformers/extra-dbs.js';

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('═══════════════════════════════════════════');
    console.log('  Notion → Supabase (추가 5개 DB)');
    console.log('═══════════════════════════════════════════\n');

    // 기존 user/lab 조회
    const user = await prisma.user.findFirst({ where: { email: 'jungmok.seo@gmail.com' } });
    if (!user) throw new Error('User not found. Run migrate-notion.ts first.');

    const lab = await prisma.lab.findFirst({ where: { ownerId: user.id } });
    if (!lab) throw new Error('Lab not found. Run migrate-notion.ts first.');

    console.log(`User: ${user.name} (${user.id})`);
    console.log(`Lab: ${lab.name} (${lab.id})\n`);

    console.log('── 1. BLISS Lab 프로젝트 ──────────────');
    await migrateLabProjects(prisma, user.id, lab.id);

    console.log('\n── 2. 빠른 메모 ───────────────────────');
    await migrateQuickMemos(prisma, user.id, lab.id);

    console.log('\n── 3. Jarvis 과제 정보 ────────────────');
    await migrateJarvisProjects(prisma, user.id, lab.id);

    console.log('\n── 4. 아이디어 박스 ───────────────────');
    await migrateIdeaBox(prisma, user.id, lab.id);

    console.log('\n── 5. 인박스 테스크 ───────────────────');
    await migrateInbox(prisma, user.id, lab.id);

    // 검증
    console.log('\n── Verification ───────────────────────');
    const memoCounts = await prisma.memo.groupBy({
      by: ['source'],
      _count: true,
    });
    for (const mc of memoCounts) {
      console.log(`  Memo(${mc.source}): ${mc._count}개`);
    }
    const captureCounts = await prisma.capture.groupBy({
      by: ['category'],
      _count: true,
    });
    for (const cc of captureCounts) {
      console.log(`  Capture(${cc.category}): ${cc._count}개`);
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('  Migration Complete!');
    console.log('═══════════════════════════════════════════');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
