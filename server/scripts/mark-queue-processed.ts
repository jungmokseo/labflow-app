/**
 * 현재 wikiRawQueue의 모든 미처리 항목을 "처리됨"으로 마킹.
 * Heavy User 시뮬레이션이 직접 article을 만들었으므로, 앱이 같은 큐를 다시 처리하지 않도록 함.
 *
 * 이후 Ingest는 Notion last_edited_time 기준으로 신규 변경만 팔로업.
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  // 사전 조회
  const pending = await prisma.wikiRawQueue.count({
    where: { labId: LAB_ID, processedAt: null },
  });
  const bySource = await prisma.wikiRawQueue.groupBy({
    by: ['sourceType'],
    where: { labId: LAB_ID, processedAt: null },
    _count: true,
  });

  console.log(`\n대상 lab: ${LAB_ID}`);
  console.log(`미처리 큐 항목: ${pending}개\n`);
  console.log('소스별:');
  for (const s of bySource) {
    console.log(`  ${s.sourceType.padEnd(20)} ${s._count}`);
  }

  if (pending === 0) {
    console.log('\n마킹할 항목 없음. 종료.');
    await prisma.$disconnect();
    return;
  }

  // 전체 마킹
  const now = new Date();
  const result = await prisma.wikiRawQueue.updateMany({
    where: { labId: LAB_ID, processedAt: null },
    data: { processedAt: now },
  });

  console.log(`\n✓ ${result.count}개 항목 processedAt 설정 완료 (${now.toISOString()})`);
  console.log('이제 다음 Ingest는 이후 변경된 Notion 페이지만 팔로업합니다.');

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
