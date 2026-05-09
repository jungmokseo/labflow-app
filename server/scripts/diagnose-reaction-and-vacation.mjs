import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

console.log('═══════════════════════════════════════════');
console.log('1. SLACK REACTION TRIGGER 진단 (Capture 테이블)');
console.log('═══════════════════════════════════════════');

// 모든 bliss-slack source의 capture
const allBlissSlack = await p.capture.findMany({
  where: { sourceType: 'slack' },
  select: { id: true, summary: true, metadata: true, reviewed: true, status: true, completed: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 30,
});
console.log(`총 sourceType='slack' captures: ${allBlissSlack.length}`);

if (allBlissSlack.length > 0) {
  console.log('\n--- 최근 10건 ---');
  for (const c of allBlissSlack.slice(0, 10)) {
    const meta = c.metadata || {};
    const source = meta.blissSource || {};
    console.log(`[${c.createdAt.toISOString().slice(0,16)}] ${c.summary?.slice(0,50)}`);
    console.log(`  reviewed=${c.reviewed} status=${c.status} completed=${c.completed}`);
    console.log(`  sourceChannel="${source.sourceChannel || 'N/A'}" slackReaction="${meta.slackReaction || 'N/A'}"`);
  }

  // Reaction trigger 항목만 필터
  const reactionTriggered = allBlissSlack.filter(c => {
    const meta = c.metadata || {};
    const source = meta.blissSource || {};
    return source.sourceChannel?.startsWith('reaction:') || meta.slackReaction;
  });
  console.log(`\n🔖 Reaction triggered 항목: ${reactionTriggered.length}건`);

  // shortcut trigger
  const shortcutTriggered = allBlissSlack.filter(c => {
    const meta = c.metadata || {};
    const source = meta.blissSource || {};
    return source.sourceChannel === 'shortcut';
  });
  console.log(`⌨️  Shortcut triggered 항목: ${shortcutTriggered.length}건`);

  // 검토 큐 쿼리 (inbox-summary와 동일)
  const reviewQueue = allBlissSlack.filter(c => {
    return c.reviewed === false && c.status === 'active' && c.metadata?.blissSource;
  });
  console.log(`📥 검토 큐에 표시될 항목 (reviewed=false + status=active + blissSource 있음): ${reviewQueue.length}건`);
}

console.log('\n═══════════════════════════════════════════');
console.log('2. VACATION 진단');
console.log('═══════════════════════════════════════════');

// labflow-app은 vacation을 직접 저장 안 함 — labflow-member에서 fetch
// 대신 vacation_calendar_sync 테이블 확인 (이전 메모리)
try {
  const calSyncCount = await p.$queryRaw`SELECT COUNT(*) as count FROM vacation_calendar_sync`;
  console.log(`vacation_calendar_sync 행 수: ${JSON.stringify(calSyncCount)}`);
} catch (e) {
  console.log(`vacation_calendar_sync 테이블 없음: ${e.message?.slice(0,80)}`);
}

await p.$disconnect();
