/**
 * Notion → Supabase 데이터 마이그레이션
 * 실행: npx tsx scripts/migrate-notion.ts
 */
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

import { setupLabAndUser } from './transformers/lab-setup.js';
import { migrateMembers } from './transformers/members.js';
import { migrateProjects } from './transformers/projects.js';
import { migrateFaq } from './transformers/faq.js';
import { migrateRegulations } from './transformers/regulations.js';
import { migrateVacations } from './transformers/vacations.js';
import { migrateAccounts } from './transformers/accounts.js';
import { buildKnowledgeGraph } from './graph-builder.js';
import { verify } from './verify.js';

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('═══════════════════════════════════════════');
    console.log('  Notion → Supabase Migration');
    console.log('═══════════════════════════════════════════\n');

    // 1. User + Lab 생성
    console.log('── Step 1: User + Lab ──────────────────');
    const { user, lab } = await setupLabAndUser(prisma);

    // 2. LabMember 생성
    console.log('\n── Step 2: LabMember ───────────────────');
    await migrateMembers(prisma, lab.id);

    // 3. Project 생성
    console.log('\n── Step 3: Project ────────────────────');
    await migrateProjects(prisma, lab.id);

    // 4. Memo 4종 생성
    console.log('\n── Step 4: Memo (FAQ) ─────────────────');
    await migrateFaq(prisma, user.id, lab.id);

    console.log('\n── Step 5: Memo (Regulation) ──────────');
    await migrateRegulations(prisma, user.id, lab.id);

    console.log('\n── Step 6: Memo (Vacation) ────────────');
    await migrateVacations(prisma, user.id);

    console.log('\n── Step 7: Memo (Account) ─────────────');
    await migrateAccounts(prisma, user.id);

    // 5. Knowledge Graph
    console.log('\n── Step 8: Knowledge Graph ────────────');
    await buildKnowledgeGraph(prisma, user.id);

    // 6. 검증
    console.log('\n── Step 9: Verification ───────────────');
    await verify(prisma);

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
