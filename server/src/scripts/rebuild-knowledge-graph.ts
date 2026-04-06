/**
 * Rebuild Knowledge Graph — 기존 데이터에서 지식 그래프 재구축
 *
 * Usage: npx tsx server/src/scripts/rebuild-knowledge-graph.ts
 *
 * 기존 DB의 미팅 노트, 채팅 메시지, 캡처(메모/태스크/아이디어)에서
 * 엔티티와 관계를 재추출하여 KnowledgeNode / KnowledgeEdge를 구축합니다.
 *
 * - Gemini Flash로 텍스트에서 관계 추출
 * - 같은 엔티티는 upsert (중복 방지)
 * - 같은 관계는 weight++ (반복 강화)
 * - rate limit 방지를 위해 500ms 간격으로 처리
 */

import { basePrismaClient as prisma } from '../config/prisma.js';
import { buildGraphFromText } from '../services/knowledge-graph.js';

const DELAY_MS = 500; // Gemini rate limit 방지

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Knowledge Graph 재구축 시작 ===\n');

  // 현재 그래프 상태
  const [nodeCount, edgeCount] = await Promise.all([
    prisma.knowledgeNode.count(),
    prisma.knowledgeEdge.count(),
  ]);
  console.log(`[현재 상태] 노드: ${nodeCount}개, 엣지: ${edgeCount}개\n`);

  // ── 1. 미팅 노트 ──────────────────────────────────────
  console.log('[1/4] 미팅 노트 로딩...');
  const meetings = await prisma.meeting.findMany({
    where: { summary: { not: null } },
    select: { id: true, userId: true, title: true, summary: true, discussions: true, actionItems: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`  → ${meetings.length}건 발견`);

  let processed = 0;
  let errors = 0;

  for (const m of meetings) {
    const text = [
      `미팅: ${m.title}`,
      m.summary,
      m.discussions,
      m.actionItems?.length ? `액션 아이템: ${m.actionItems.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    if (text.length < 30) continue;

    try {
      await buildGraphFromText(m.userId, text, 'meeting');
      processed++;
      process.stdout.write(`\r  처리: ${processed}/${meetings.length}`);
    } catch (err) {
      errors++;
    }
    await sleep(DELAY_MS);
  }
  console.log(`\n  ✅ 미팅 완료: ${processed}건 처리, ${errors}건 실패\n`);

  // ── 2. 채팅 메시지 (유저+어시스턴트 쌍) ──────────────────
  console.log('[2/4] Brain 채팅 로딩...');
  const channels = await prisma.channel.findMany({
    where: { shadow: false, archived: false },
    select: { id: true, userId: true },
  });

  let chatProcessed = 0;
  let chatErrors = 0;

  for (const ch of channels) {
    const messages = await prisma.message.findMany({
      where: { channelId: ch.id },
      select: { role: true, content: true },
      orderBy: { createdAt: 'asc' },
      take: 50, // 최근 50개 메시지만
    });

    if (messages.length < 2) continue;

    // 대화를 하나의 텍스트로 합침
    const chatText = messages
      .map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`)
      .join('\n')
      .substring(0, 3000);

    try {
      await buildGraphFromText(ch.userId, chatText, 'chat');
      chatProcessed++;
      process.stdout.write(`\r  처리: ${chatProcessed}/${channels.length} 채널`);
    } catch {
      chatErrors++;
    }
    await sleep(DELAY_MS);
  }
  console.log(`\n  ✅ 채팅 완료: ${chatProcessed}건 처리, ${chatErrors}건 실패\n`);

  // ── 3. 캡처 (메모/태스크/아이디어) ────────────────────────
  console.log('[3/4] 캡처 로딩...');
  const captures = await prisma.capture.findMany({
    select: { id: true, userId: true, content: true, summary: true, tags: true, category: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`  → ${captures.length}건 발견`);

  let capProcessed = 0;
  let capErrors = 0;

  // 캡처는 개별이 짧으므로 10개씩 묶어서 처리
  const BATCH_SIZE = 10;
  const userCaptures = new Map<string, typeof captures>();
  for (const c of captures) {
    if (!userCaptures.has(c.userId)) userCaptures.set(c.userId, []);
    userCaptures.get(c.userId)!.push(c);
  }

  for (const [userId, caps] of userCaptures) {
    for (let i = 0; i < caps.length; i += BATCH_SIZE) {
      const batch = caps.slice(i, i + BATCH_SIZE);
      const batchText = batch
        .map(c => `[${c.category}] ${c.summary || c.content}${c.tags?.length ? ` (태그: ${c.tags.join(', ')})` : ''}`)
        .join('\n');

      if (batchText.length < 20) continue;

      try {
        await buildGraphFromText(userId, batchText, 'capture' as any);
        capProcessed += batch.length;
        process.stdout.write(`\r  처리: ${capProcessed}/${captures.length}`);
      } catch {
        capErrors += batch.length;
      }
      await sleep(DELAY_MS);
    }
  }
  console.log(`\n  ✅ 캡처 완료: ${capProcessed}건 처리, ${capErrors}건 실패\n`);

  // ── 4. 메모 (Lab Memory) ──────────────────────────────
  console.log('[4/4] 메모 로딩...');
  const memos = await prisma.memo.findMany({
    select: { id: true, userId: true, title: true, content: true, tags: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`  → ${memos.length}건 발견`);

  let memoProcessed = 0;
  let memoErrors = 0;

  // 메모도 10개씩 묶어서
  const userMemos = new Map<string, typeof memos>();
  for (const m of memos) {
    if (!userMemos.has(m.userId)) userMemos.set(m.userId, []);
    userMemos.get(m.userId)!.push(m);
  }

  for (const [userId, mms] of userMemos) {
    for (let i = 0; i < mms.length; i += BATCH_SIZE) {
      const batch = mms.slice(i, i + BATCH_SIZE);
      const batchText = batch
        .map(m => `${m.title ? m.title + ': ' : ''}${m.content}${m.tags?.length ? ` (태그: ${m.tags.join(', ')})` : ''}`)
        .join('\n');

      if (batchText.length < 20) continue;

      try {
        await buildGraphFromText(userId, batchText, 'manual');
        memoProcessed += batch.length;
        process.stdout.write(`\r  처리: ${memoProcessed}/${memos.length}`);
      } catch {
        memoErrors += batch.length;
      }
      await sleep(DELAY_MS);
    }
  }
  console.log(`\n  ✅ 메모 완료: ${memoProcessed}건 처리, ${memoErrors}건 실패\n`);

  // ── 결과 요약 ─────────────────────────────────────────
  const [finalNodes, finalEdges] = await Promise.all([
    prisma.knowledgeNode.count(),
    prisma.knowledgeEdge.count(),
  ]);

  console.log('=== 재구축 완료 ===');
  console.log(`  노드: ${nodeCount} → ${finalNodes} (+${finalNodes - nodeCount})`);
  console.log(`  엣지: ${edgeCount} → ${finalEdges} (+${finalEdges - edgeCount})`);
  console.log(`  소스: 미팅 ${processed} + 채팅 ${chatProcessed} + 캡처 ${capProcessed} + 메모 ${memoProcessed}`);
  console.log(`  실패: ${errors + chatErrors + capErrors + memoErrors}건`);

  process.exit(0);
}

main().catch(err => {
  console.error('[fatal] 재구축 실패:', err);
  process.exit(1);
});
