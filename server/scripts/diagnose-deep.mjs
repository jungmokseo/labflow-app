import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

console.log('═══ 정확한 inbox-summary 쿼리 시뮬레이션 ═══');

// inbox-summary.ts와 100% 동일한 조건
const reviewQueueCount = await p.capture.count({
  where: {
    reviewed: false,
    category: 'TASK',
    status: 'active',
    metadata: { path: ['blissSource'], not: 'JsonNull' },
  },
});
console.log(`category='TASK' + reviewed=false + status=active + blissSource not null: ${reviewQueueCount}`);

// JsonNull 차이로 조회 안 될 수 있음 — Prisma.JsonNull로 다시
const reviewQueueCount2 = await p.capture.findMany({
  where: { reviewed: false, status: 'active', category: 'TASK' },
  select: { id: true, summary: true, metadata: true, category: true, createdAt: true },
});
console.log(`category='TASK' 단순 쿼리 (manual blissSource 검사): ${reviewQueueCount2.length}`);

// blissSource 직접 검사
const withBlissSource = reviewQueueCount2.filter(c => {
  return c.metadata && typeof c.metadata === 'object' && 'blissSource' in c.metadata;
});
console.log(`이 중 metadata.blissSource 있는 것: ${withBlissSource.length}`);

console.log('\n--- TASK + blissSource 항목 ---');
for (const c of withBlissSource.slice(0, 8)) {
  const source = c.metadata?.blissSource || {};
  console.log(`  [${c.createdAt.toISOString().slice(0,16)}] ${c.summary?.slice(0,40)}`);
  console.log(`    sourceChannel="${source.sourceChannel}" requesterName="${source.requesterName}"`);
}

console.log('\n--- TASK 아닌 (그러나 sourceType=slack인) 항목 — 누락 가능 ---');
const slackNotTask = await p.capture.findMany({
  where: { sourceType: 'slack', category: { not: 'TASK' } },
  select: { id: true, summary: true, category: true, status: true, reviewed: true, createdAt: true },
  take: 10,
  orderBy: { createdAt: 'desc' },
});
console.log(`sourceType='slack'이지만 category!='TASK': ${slackNotTask.length}건`);
for (const c of slackNotTask.slice(0, 5)) {
  console.log(`  [${c.createdAt.toISOString().slice(0,16)}] cat=${c.category} ${c.summary?.slice(0,50)}`);
}

console.log('\n═══ Reaction trigger 항목 상세 ═══');
const reaction = await p.capture.findMany({
  where: { sourceType: 'slack', summary: { contains: 'globe' } },
  select: { id: true, summary: true, content: true, category: true, reviewed: true, status: true, metadata: true, createdAt: true },
  take: 3,
});
for (const r of reaction) {
  console.log(`id=${r.id}`);
  console.log(`  category=${r.category} reviewed=${r.reviewed} status=${r.status}`);
  console.log(`  summary=${r.summary?.slice(0,80)}`);
  console.log(`  content=${r.content?.slice(0,80)}`);
  const meta = r.metadata || {};
  console.log(`  metadata.blissSource=${JSON.stringify(meta.blissSource).slice(0,200)}`);
}

await p.$disconnect();
